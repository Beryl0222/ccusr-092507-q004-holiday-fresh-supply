import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { validateEvent } from "../contracts.js";
import { buildReadModel } from "./projection.js";
import { settleDelivery, round2 } from "./settlement.js";
import { InMemoryEventStore, KeyedMutex, ConcurrencyConflict, contentFingerprint } from "./store.js";

const schema = JSON.parse(
  await readFile(fileURLToPath(new URL("../../contracts/domain.schema.json", import.meta.url)), "utf8"),
);

export class DomainRejected extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainRejected";
    this.code = code;
    this.details = details;
  }
}

export class ClearingService {
  constructor(store = new InMemoryEventStore(), options = {}) {
    this.store = store;
    this.mutex = new KeyedMutex();
    this.now = options.now ?? (() => new Date().toISOString());
    this.idGen = options.idGen ?? ((type) => `${type}-${randomUUID()}`);
    this.overnightRate = options.overnightRate ?? 0;
    this.shortfallRate = options.shortfallRate ?? 0;
    this.timeZone = options.timeZone ?? "Asia/Shanghai";
  }

  snapshot() {
    return buildReadModel(this.store.all());
  }

  #append(type, aggregateType, aggregateId, payload, expectedVersion) {
    const streamLength = this.store.read(aggregateId).length;
    if (expectedVersion !== undefined && streamLength !== expectedVersion) {
      throw new ConcurrencyConflict(aggregateId, expectedVersion, streamLength);
    }
    const event = {
      event_id: this.idGen(type, aggregateId),
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.now(),
      version: streamLength + 1,
      payload,
    };
    const issues = validateEvent(event, schema);
    if (issues.length > 0) throw new DomainRejected("CONTRACT_VIOLATION", "事件不满足契约", { issues });
    return this.store.append(event, expectedVersion);
  }

  // 事件循环单线程内同步临界区即可串行化；跨进程部署时由数据库行锁/SERIALIZABLE 事务承担。
  #locked(keys, task) {
    return task();
  }

  // 传输层适配器可用它把同一批次的请求排队（演示并发确认的最后一份额度语义）。
  withLotLock(lotId, task) {
    return this.mutex.run(`lot:${lotId}`, task);
  }

  resolveDispute(cmd) {
    const replayed = this.store.all().find(
      (event) => event.event_type === "DISPUTE_RESOLVED" && event.payload.dispute_id === cmd.dispute_id,
    );
    if (replayed) return { status: "replayed", event: replayed };
    const exists = this.snapshot().disputes.some((dispute) => dispute.dispute_id === cmd.dispute_id && dispute.status === "open");
    if (!exists) throw new DomainRejected("DISPUTE_NOT_OPEN", `争议 ${cmd.dispute_id} 不存在或已处理`);
    const event = this.#append("DISPUTE_RESOLVED", "dispute", cmd.dispute_id, {
      dispute_id: cmd.dispute_id,
      resolution: cmd.resolution,
      operator_id: cmd.operator_id,
    });
    return { status: "resolved", event };
  }

  // ---------- 货源批次 ----------

  declareLot(cmd) {
    const lotId = cmd.lot_id;
    if (this.store.exists(lotId)) throw new DomainRejected("LOT_EXISTS", `批次 ${lotId} 已存在`);
    return this.#append("LOT_DECLARED", "supply_lot", lotId, {
      supplier_id: cmd.supplier_id,
      category: cmd.category,
      grade: cmd.grade,
      unit: cmd.unit,
      quantity: cmd.quantity,
      arrival_window: cmd.arrival_window,
      price_range: cmd.price_range,
    }, 0);
  }

  #lotEvent(type, lotId, payload) {
    return this.#locked([`lot:${lotId}`], () => this.#append(type, "supply_lot", lotId, payload));
  }

  updateSchedule(lotId, cmd) {
    return this.#lotEvent("LOT_SCHEDULE_UPDATED", lotId, {
      vessel_trip_id: cmd.vessel_trip_id,
      arrival_window: cmd.arrival_window,
      reason: cmd.reason,
    });
  }

  lotArrived(lotId, quantity) {
    return this.#lotEvent("LOT_ARRIVED", lotId, { quantity });
  }

  inspect(lotId, cmd) {
    return this.#lotEvent("LOT_INSPECTED", lotId, {
      inspection_id: cmd.inspection_id,
      result: cmd.result,
      ...(cmd.quantity !== undefined ? { quantity: cmd.quantity } : {}),
    });
  }

  quarantine(lotId, cmd) {
    return this.#lotEvent("LOT_QUARANTINED", lotId, {
      hold_id: cmd.hold_id,
      quantity: cmd.quantity,
      reason: cmd.reason,
    });
  }

  releaseHold(lotId, cmd) {
    return this.#lotEvent("LOT_RELEASED", lotId, { hold_id: cmd.hold_id, quantity: cmd.quantity });
  }

  recordLoss(lotId, cmd) {
    return this.#lotEvent("LOT_LOSS_RECORDED", lotId, {
      quantity: cmd.quantity,
      stage: cmd.stage ?? "available",
      reason: cmd.reason,
    });
  }

  recordShortage(lotId, cmd) {
    return this.#lotEvent("LOT_SHORTAGE_RECORDED", lotId, {
      quantity: cmd.quantity,
      reason: cmd.reason,
    });
  }

  externalLock(lotId, cmd) {
    return this.#lotEvent("LOT_EXTERNAL_LOCKED", lotId, {
      quantity: cmd.quantity,
      market_ref: cmd.market_ref,
      ...(cmd.source_pool ? { source_pool: cmd.source_pool } : {}),
    });
  }

  externalUnlock(lotId, cmd) {
    return this.#lotEvent("LOT_EXTERNAL_UNLOCKED", lotId, {
      quantity: cmd.quantity,
      market_ref: cmd.market_ref,
    });
  }

  // ---------- 装卸能力 ----------

  declareCapacity(cmd) {
    return this.#append("CAPACITY_DECLARED", "handling_capacity", cmd.window_id, {
      window_id: cmd.window_id,
      start: cmd.start,
      end: cmd.end,
      quantity: cmd.quantity,
    });
  }

  // ---------- 采购需求（业务号幂等，异内容进争议） ----------

  registerDemand(cmd) {
    const content = {
      category: cmd.category,
      grade: cmd.grade,
      unit: cmd.unit,
      quantity: cmd.quantity,
      window: cmd.window,
      max_price: cmd.max_price,
    };
    const existing = this.store.read(cmd.business_no);
    if (existing.length > 0) {
      const first = existing.find((event) => event.event_type === "DEMAND_REGISTERED");
      const priorFingerprint = first ? contentFingerprint(stripEnvelope(first.payload)) : null;
      const incoming = contentFingerprint(content);
      if (priorFingerprint === incoming) {
        return { status: "replayed", event: first };
      }
      const dispute = this.#append("DISPUTE_OPENED", "dispute", this.idGen("dispute", cmd.business_no), {
        business_no: cmd.business_no,
        kind: "IDEMPOTENCY_CONTENT_MISMATCH",
        reason: "同一业务号重试携带不同需求内容",
        fingerprint_existing: priorFingerprint,
        fingerprint_incoming: incoming,
      });
      throw new DomainRejected("IDEMPOTENCY_CONTENT_MISMATCH", "同一业务号内容不一致，已进入争议", { dispute_id: dispute.aggregate_id });
    }
    const event = this.#append("DEMAND_REGISTERED", "purchase_demand", cmd.business_no, {
      business_no: cmd.business_no,
      ...content,
    });
    return { status: "accepted", event };
  }

  // ---------- 优先级冻结版本 ----------

  freezePriority(cmd) {
    return this.#append("PRIORITY_FROZEN", "allocation_round", cmd.round_id, {
      round_id: cmd.round_id,
      freeze_version: cmd.freeze_version,
      criteria: cmd.criteria,
      ranking: cmd.ranking,
    });
  }

  // ---------- 供应承诺与回执（幂等） ----------

  proposeCommitment(cmd) {
    return this.#locked([`lot:${cmd.lot_id}`], () => {
      const view = this.snapshot();
      const lot = view.lots.get(cmd.lot_id);
      if (!lot) throw new DomainRejected("LOT_NOT_FOUND", `批次 ${cmd.lot_id} 不存在`);
      const demand = view.demands.get(cmd.business_no);
      if (!demand) throw new DomainRejected("DEMAND_NOT_FOUND", `业务号 ${cmd.business_no} 未登记`);

      const replayed = [...view.commitments.values()].find((c) => c.business_no === cmd.business_no && !c.parent_id);
      if (replayed) {
        const proposalEvents = this.store.all().filter(
          (event) => event.event_type === "COMMITMENT_PROPOSED" && event.payload.business_no === cmd.business_no,
        );
        const original = proposalEvents[0];
        const incoming = contentFingerprint({
          lot_id: cmd.lot_id,
          quantity: cmd.quantity,
          price: cmd.price,
          arrival_window: cmd.arrival_window,
        });
        const prior = contentFingerprint({
          lot_id: original.payload.lot_id,
          quantity: original.payload.quantity,
          price: original.payload.price,
          arrival_window: original.payload.arrival_window,
        });
        if (incoming === prior) return { status: "replayed", event: original };
        const dispute = this.#append("DISPUTE_OPENED", "dispute", this.idGen("dispute", cmd.business_no), {
          business_no: cmd.business_no,
          kind: "IDEMPOTENCY_CONTENT_MISMATCH",
          reason: "同一业务号重复承诺携带不同内容",
          fingerprint_existing: prior,
          fingerprint_incoming: incoming,
        });
        throw new DomainRejected("IDEMPOTENCY_CONTENT_MISMATCH", "同一业务号承诺内容不一致，已进入争议", { dispute_id: dispute.aggregate_id });
      }

      if (lot.atp.hard + lot.atp.soft_pending + lot.atp.soft_in_transit + 1e-9 < cmd.quantity) {
        throw new DomainRejected("ATP_INSUFFICIENT", "可承诺量不足", { atp: lot.atp });
      }
      if (cmd.price < lot.price_range.min || cmd.price > lot.price_range.max) {
        throw new DomainRejected("PRICE_OUT_OF_RANGE", "承诺价不在批次价格区间内", lot.price_range);
      }
      if (demand.max_price != null && cmd.price > demand.max_price) {
        throw new DomainRejected("PRICE_ABOVE_DEMAND_CAP", "承诺价超过采购需求最高限价", { max_price: demand.max_price });
      }
      const event = this.#append("COMMITMENT_PROPOSED", "allocation_commitment", cmd.commitment_id, {
        commitment_id: cmd.commitment_id,
        business_no: cmd.business_no,
        lot_id: cmd.lot_id,
        demand_id: demand.demand_id,
        quantity: cmd.quantity,
        price: cmd.price,
        arrival_window: cmd.arrival_window ?? lot.arrival_window,
      });
      return { status: "accepted", event };
    });
  }

  ackCommitment(cmd) {
    const view = this.snapshot();
    const commitment = view.commitments.get(cmd.commitment_id);
    if (!commitment) throw new DomainRejected("COMMITMENT_NOT_FOUND", `承诺 ${cmd.commitment_id} 不存在`);
    const incoming = contentFingerprint({ commitment_id: cmd.commitment_id, ack: cmd.ack });
    const priorEvent = this.store.all().find(
      (event) => event.event_type === "COMMITMENT_ACKED" && event.payload.business_no === cmd.business_no,
    );
    if (priorEvent) {
      const prior = contentFingerprint({
        commitment_id: priorEvent.payload.commitment_id,
        ack: priorEvent.payload.ack,
      });
      if (prior === incoming) return { status: "replayed", event: priorEvent };
      const dispute = this.#append("DISPUTE_OPENED", "dispute", this.idGen("dispute", cmd.business_no), {
        business_no: cmd.business_no,
        kind: "IDEMPOTENCY_CONTENT_MISMATCH",
        reason: "供应商补传回执与首次内容不一致",
        fingerprint_existing: prior,
        fingerprint_incoming: incoming,
      });
      throw new DomainRejected("IDEMPOTENCY_CONTENT_MISMATCH", "回执内容不一致，已进入争议", { dispute_id: dispute.aggregate_id });
    }
    const event = this.#append("COMMITMENT_ACKED", "purchase_demand", cmd.business_no, {
      business_no: cmd.business_no,
      commitment_id: cmd.commitment_id,
      ack: cmd.ack,
    });
    return { status: "accepted", event };
  }

  // ---------- 确认成交：乐观锁 + 批次互斥，最后一份额度只有一个采购方成交 ----------

  confirmAllocation(cmd) {
    const lotId = cmd.lot_id
      ?? this.snapshot().commitments.get(cmd.commitment_id)?.lot_id
      ?? this.#lotOfCommitment(cmd.commitment_id);
    return this.#locked([`lot:${lotId}`], () => {
      const streamLength = this.store.read(lotId).length;
      if (cmd.expected_version !== undefined && streamLength !== cmd.expected_version) {
        throw new ConcurrencyConflict(lotId, cmd.expected_version, streamLength);
      }
      const view = this.snapshot();
      const commitment = view.commitments.get(cmd.commitment_id);
      if (!commitment) throw new DomainRejected("COMMITMENT_NOT_FOUND", `承诺 ${cmd.commitment_id} 不存在`);
      const remaining = round2(commitment.quantity - commitment.confirmed - (commitment.moved_out ?? 0));
      if (remaining <= 1e-9) {
        throw new DomainRejected("ALREADY_CONFIRMED", "承诺已全部确认，重复确认被拒绝");
      }
      // 可分批确认（如渔船只到一部分货）；默认确认剩余全部。
      const requested = round2(cmd.quantity ?? remaining);
      if (requested - remaining > 1e-9) {
        throw new DomainRejected("OVER_CONFIRM", "确认量超过承诺未确认部分", { remaining });
      }
      const lot = view.lots.get(lotId);
      if (lot.buckets.available + 1e-9 < requested) {
        throw new DomainRejected("ATP_INSUFFICIENT", "硬额度不足：货尚未检验通过或已被占用", {
          atp: lot.atp,
          available: lot.buckets.available,
        });
      }
      const windowId = commitment.arrival_window?.id ?? null;
      if (windowId) {
        const capacity = view.capacities.get(windowId);
        if (capacity && capacity.remaining + 1e-9 < requested) {
          throw new DomainRejected("CAPACITY_INSUFFICIENT", "到货窗口装卸能力不足", { capacity });
        }
      }
      const events = [
        this.#appendRaw("ALLOCATION_CONFIRMED", "supply_lot", lotId, {
          commitment_id: commitment.commitment_id,
          quantity: requested,
          freeze_version: cmd.freeze_version ?? null,
          demand_id: commitment.demand_id,
          business_no: commitment.business_no,
        }),
      ];
      if (windowId) {
        events.push(this.#appendRaw("CAPACITY_RESERVED", "handling_capacity", windowId, {
          lot_id: lotId,
          demand_id: commitment.demand_id,
          window_id: windowId,
          quantity: requested,
        }));
      }
      return { status: requested < remaining - 1e-9 ? "partially_confirmed" : "confirmed", events };
    });
  }

  #appendRaw(type, aggregateType, aggregateId, payload) {
    const event = {
      event_id: this.idGen(type, aggregateId),
      event_type: type,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.now(),
      version: this.store.read(aggregateId).length + 1,
      payload,
    };
    const issues = validateEvent(event, schema);
    if (issues.length > 0) throw new DomainRejected("CONTRACT_VIOLATION", "事件不满足契约", { issues });
    return this.store.append(event);
  }

  #lotOfCommitment(commitmentId) {
    const found = this.store.all().find(
      (event) => event.event_type === "COMMITMENT_PROPOSED" && event.aggregate_id === commitmentId,
    );
    if (!found) throw new DomainRejected("COMMITMENT_NOT_FOUND", `承诺 ${commitmentId} 不存在`);
    return found.payload.lot_id;
  }

  // ---------- 触发重排：封存 / 船期 / 短缺只动尚未交收部分，按冻结版本排序 ----------

  rearrange(cmd) {
    const round = this.snapshot().rounds.get(cmd.round_id);
    if (!round) throw new DomainRejected("ROUND_NOT_FROZEN", `分配轮次 ${cmd.round_id} 未冻结优先级`);
    const affectedLotIds = cmd.lot_ids ?? [];
    return this.#locked(
      affectedLotIds.map((id) => `lot:${id}`),
      () => {
        const view = this.snapshot();
        const rankOf = (demandId) => {
          const entry = round.ranking.find(
            (item) => (typeof item === "string" ? item : item.demand_id) === demandId,
          );
          return entry && typeof entry !== "string" && entry.priority !== undefined
            ? entry.priority
            : round.ranking.indexOf(entry);
        };

        const items = [];

        for (const lotId of affectedLotIds) {
          const lot = view.lots.get(lotId);
          if (!lot) continue;
          const impairmentByCommitment = new Map(lot.impaired_promises.map((entry) => [entry.commitment_id, entry.quantity]));

          // 按冻结优先级展开需求：每个承诺先补已占用受损，再补未确认承诺受损。
          const open = [...view.commitments.values()]
            .filter((c) => c.lot_id === lotId)
            .toSorted((a, b) => rankOf(a.demand_id) - rankOf(b.demand_id));

          // 已占用受损量分摊：allocated 桶位按优先级顺序覆盖各承诺的未交收占用。
          let support = lot.buckets.allocated;
          const confirmedHits = new Map();
          for (const commitment of open) {
            if (commitment.open_allocated <= 1e-9) continue;
            const covered = Math.min(commitment.open_allocated, Math.max(support, 0));
            support -= commitment.open_allocated;
            const hit = round2(commitment.open_allocated - covered);
            if (hit > 1e-9) confirmedHits.set(commitment.commitment_id, hit);
          }

          const claimReplacement = (commitment, hit, stage) => {
            const demand = view.demands.get(commitment.business_no);
            let rest = hit;
            const candidates = [
              view.lots.get(lotId),
              ...[...view.lots.values()].filter(
                (candidate) => candidate.lot_id !== lotId
                  && candidate.category === demand?.category
                  && candidate.grade === demand?.grade
                  && candidate.price_range.min <= (demand?.max_price ?? Infinity),
              ).toSorted((a, b) => a.price_range.min - b.price_range.min),
            ];
            for (const candidate of candidates) {
              if (rest <= 1e-9) break;
              // candidate.buckets 已随本轮预占递减；承诺挂账量在重排中不变。
              const free = candidate.buckets.available - candidate.promised_by_pool.available;
              const take = Math.min(free, rest);
              if (take > 1e-9) {
                items.push({
                  commitment_id: commitment.commitment_id,
                  split_commitment_id: candidate.lot_id === lotId
                    ? commitment.commitment_id
                    : this.idGen("commitment", `${commitment.commitment_id}-${candidate.lot_id}`),
                  action: "moved",
                  stage,
                  from_lot_id: lotId,
                  to_lot_id: candidate.lot_id,
                  quantity: round2(take),
                });
                candidate.buckets.available -= take;
                candidate.buckets.allocated += take;
                rest -= take;
              }
            }
            if (rest > 1e-9) {
              items.push({
                commitment_id: commitment.commitment_id,
                action: "short_closed",
                stage,
                from_lot_id: lotId,
                quantity: round2(rest),
                reason: cmd.trigger,
              });
            }
          };

          for (const commitment of open) {
            const confirmedHit = confirmedHits.get(commitment.commitment_id) ?? 0;
            if (confirmedHit > 1e-9) claimReplacement(commitment, confirmedHit, "allocated");

            // 未确认承诺中被封存/短缺/外锁/拒收侵蚀的部分（在途与待检标签已注销）。
            const unconfirmed = Math.max(0, round2(commitment.quantity - commitment.confirmed - (commitment.moved_out ?? 0) - commitment.short_closed));
            const promiseHit = Math.min(unconfirmed, impairmentByCommitment.get(commitment.commitment_id) ?? 0);
            if (promiseHit > 1e-9) claimReplacement(commitment, round2(promiseHit), "promise");
          }
        }
        if (items.length === 0) return { status: "unchanged", items: [] };
        const event = this.#append("ALLOCATION_REARRANGED", "allocation_round", cmd.round_id, {
          round_id: cmd.round_id,
          freeze_version: round.freeze_version,
          trigger: cmd.trigger,
          items,
        });
        return { status: "rearranged", event, items };
      },
    );
  }

  // ---------- 人工改派：必须说明理由，且不突破数量守恒 ----------

  reassign(cmd) {
    if (!cmd.reason || !cmd.reason.trim()) {
      throw new DomainRejected("REASON_REQUIRED", "人工改派必须说明理由");
    }
    return this.#locked([`lot:${this.#lotOfCommitment(cmd.commitment_id)}`], () => {
      const view = this.snapshot();
      const source = view.commitments.get(cmd.commitment_id);
      if (!source) throw new DomainRejected("COMMITMENT_NOT_FOUND", `承诺 ${cmd.commitment_id} 不存在`);
      const target = view.demands.get(cmd.to_business_no);
      if (!target) throw new DomainRejected("DEMAND_NOT_FOUND", `转入业务号 ${cmd.to_business_no} 未登记`);
      const sourceDemand = view.demands.get(source.business_no);
      if (sourceDemand && (sourceDemand.category !== target.category || sourceDemand.grade !== target.grade)) {
        throw new DomainRejected("GRADE_MISMATCH", "改派只能在同品类同等级需求间进行");
      }
      if (cmd.quantity - source.open_allocated > 1e-9) {
        throw new DomainRejected("QUANTITY_CONSERVATION", "改派量不能超过尚未交收的占用量", {
          open_allocated: source.open_allocated,
        });
      }
      const before = this.#lotTotal(view, source.lot_id);
      const event = this.#append("ALLOCATION_REASSIGNED", "allocation_commitment", cmd.new_commitment_id, {
        commitment_id: cmd.commitment_id,
        from_demand_id: source.demand_id,
        to_demand_id: target.demand_id,
        to_business_no: cmd.to_business_no,
        quantity: cmd.quantity,
        reason: cmd.reason,
        operator_id: cmd.operator_id,
      });
      const after = this.#lotTotal(this.snapshot(), source.lot_id);
      if (Math.abs(before - after) > 1e-9) {
        throw new DomainRejected("QUANTITY_CONSERVATION", "改派破坏了批次数量守恒");
      }
      return { status: "reassigned", event };
    });
  }

  #lotTotal(view, lotId) {
    const lot = view.lots.get(lotId);
    return lot ? Object.values(lot.buckets).reduce((sum, value) => sum + value, 0) : 0;
  }

  // ---------- 实际交收 ----------

  acceptDelivery(cmd) {
    const replayed = this.store.all().find(
      (event) => event.event_type === "DELIVERY_ACCEPTED" && event.payload.delivery_id === cmd.delivery_id,
    );
    if (replayed) return { status: "replayed", event: replayed };
    const commitmentLot = this.snapshot().commitments.get(cmd.commitment_id)?.lot_id
      ?? this.#lotOfCommitment(cmd.commitment_id);
    return this.#locked([`lot:${commitmentLot}`], () => {
      const view = this.snapshot();
      const commitment = view.commitments.get(cmd.commitment_id);
      if (!commitment) throw new DomainRejected("COMMITMENT_NOT_FOUND", `承诺 ${cmd.commitment_id} 不存在`);
      if (cmd.quantity - commitment.open_allocated > 1e-9) {
        throw new DomainRejected("OVER_DELIVERY", "实交量超过未交收占用量", {
          open_allocated: commitment.open_allocated,
        });
      }
      const lotId = commitment.lot_id;
      const events = [
        this.#appendRaw("DELIVERY_ACCEPTED", "supply_lot", lotId, {
          delivery_id: cmd.delivery_id,
          commitment_id: cmd.commitment_id,
          lot_id: lotId,
          quantity: cmd.quantity,
          accepted_at: cmd.accepted_at ?? this.now(),
        }),
      ];
      const windowId = commitment.arrival_window?.id ?? null;
      if (windowId) {
        events.push(this.#appendRaw("CAPACITY_RELEASED", "handling_capacity", windowId, {
          window_id: windowId,
          quantity: cmd.quantity,
        }));
      }
      return { status: "accepted", events };
    });
  }

  // ---------- 清算：按实际交收版本，跨午夜/短交/退补价；出账后只能冲正 ----------

  postSettlement(cmd) {
    const view = this.snapshot();
    if (view.periods.has(cmd.period_id)) {
      throw new DomainRejected("PERIOD_CLOSED", `周期 ${cmd.period_id} 已关账，请走冲正`);
    }
    const replayed = this.store.all().find(
      (event) => event.event_type === "SETTLEMENT_POSTED"
        && event.payload.delivery_id === cmd.delivery_id
        && event.payload.period_id === cmd.period_id,
    );
    if (replayed) return { status: "replayed", event: replayed };

    const delivery = this.store.all().find(
      (event) => event.event_type === "DELIVERY_ACCEPTED" && event.payload.delivery_id === cmd.delivery_id,
    );
    if (!delivery) throw new DomainRejected("DELIVERY_NOT_FOUND", `交收 ${cmd.delivery_id} 不存在`);
    const commitment = view.commitments.get(delivery.payload.commitment_id);
    const computed = settleDelivery({
      commitment,
      delivery: delivery.payload,
      finalPrice: cmd.final_price ?? null,
      overnightRate: cmd.overnight_rate ?? this.overnightRate,
      shortfallRate: cmd.shortfall_rate ?? this.shortfallRate,
      timeZone: this.timeZone,
    });
    const event = this.#append("SETTLEMENT_POSTED", "settlement_entry", cmd.entry_id ?? `entry-${cmd.delivery_id}`, {
      period_id: cmd.period_id,
      delivery_id: cmd.delivery_id,
      commitment_id: commitment.commitment_id,
      lot_id: commitment.lot_id,
      demand_id: commitment.demand_id,
      business_no: commitment.business_no,
      freeze_version: commitment.freeze_version,
      lines: computed.lines,
      amount: computed.amount,
    });
    return { status: "posted", event, settlement: computed };
  }

  reverseSettlement(cmd) {
    const view = this.snapshot();
    const original = view.entries.get(cmd.original_entry_id);
    if (!original || original.is_reversal) {
      throw new DomainRejected("ENTRY_NOT_FOUND", "待冲正账项不存在");
    }
    if (original.reversed) {
      const reversal = view.entries.get(original.reversal_entry_id);
      return { status: "replayed", event: this.store.read(reversal.entry_id)[0] };
    }
    const event = this.#append("SETTLEMENT_REVERSED", "settlement_entry", cmd.entry_id ?? `reversal-${original.entry_id}`, {
      period_id: cmd.period_id ?? original.period_id,
      original_entry_id: original.entry_id,
      delivery_id: original.delivery_id,
      amount: round2(-original.amount),
      reason: cmd.reason,
    });
    return { status: "reversed", event };
  }

  closePeriod(periodId) {
    const replayed = this.store.read(periodId).find((event) => event.event_type === "PERIOD_CLOSED");
    if (replayed) return { status: "replayed", event: replayed };
    return { status: "closed", event: this.#append("PERIOD_CLOSED", "settlement_period", periodId, { period_id: periodId }) };
  }

  // 财务批处理：逐条过账，中断后重跑只补未完成账项（交收号幂等）。
  async runSettlementBatch(cmd, { failAfter = null } = {}) {
    const posted = [];
    const skipped = [];
    let processed = 0;
    for (const item of cmd.items) {
      if (failAfter !== null && processed >= failAfter) {
        return { status: "interrupted", posted, skipped, remaining: cmd.items.slice(processed) };
      }
      const result = this.postSettlement({ ...item, period_id: cmd.period_id });
      posted.push({ delivery_id: item.delivery_id, status: result.status, entry_id: result.event.aggregate_id });
      processed += 1;
    }
    return { status: "completed", posted, skipped };
  }

  // ---------- 付款：每笔都能追到货源、检验、占用与交收事实 ----------

  issuePayment(cmd) {
    const view = this.snapshot();
    const replayed = view.payments.get(cmd.payment_id);
    if (replayed) {
      const incoming = contentFingerprint(cmd.settlement_entry_ids.slice().sort());
      const prior = contentFingerprint(replayed.settlement_entry_ids.slice().sort());
      if (incoming !== prior) {
        throw new DomainRejected("PAYMENT_CONTENT_MISMATCH", "同一付款号对应不同账项集合");
      }
      return { status: "replayed", event: this.store.all().find((e) => e.aggregate_id === cmd.payment_id) };
    }
    const provenance = cmd.settlement_entry_ids.map((entryId) => this.#traceEntry(view, entryId));
    const amount = round2(provenance.reduce((sum, item) => sum + item.amount, 0));
    const event = this.#append("PAYMENT_ISSUED", "payment", cmd.payment_id, {
      payment_id: cmd.payment_id,
      settlement_entry_ids: cmd.settlement_entry_ids,
      amount,
      provenance,
    });
    return { status: "issued", event, amount, provenance };
  }

  #traceEntry(view, entryId) {
    const entry = view.entries.get(entryId);
    if (!entry) throw new DomainRejected("ENTRY_NOT_FOUND", `账项 ${entryId} 不存在`);
    if (entry.is_reversal) {
      return { entry_id: entry.entry_id, is_reversal: true, amount: entry.amount, original_entry_id: entry.original_entry_id };
    }
    const lot = view.lots.get(entry.lot_id);
    const lotEvents = this.store.all().filter(
      (event) => event.aggregate_id === entry.lot_id ||
        (event.event_type === "ALLOCATION_REARRANGED" &&
          (event.payload.items ?? []).some((item) => item.from_lot_id === entry.lot_id || item.to_lot_id === entry.lot_id)),
    );
    const delivery = lotEvents.find(
      (event) => event.event_type === "DELIVERY_ACCEPTED" && event.payload.delivery_id === entry.delivery_id,
    );
    return {
      entry_id: entry.entry_id,
      period_id: entry.period_id,
      amount: entry.amount,
      lines: entry.lines,
      commitment: {
        commitment_id: entry.commitment_id,
        business_no: entry.business_no,
        demand_id: entry.demand_id,
        freeze_version: entry.freeze_version,
      },
      delivery: delivery
        ? { delivery_id: delivery.payload.delivery_id, quantity: delivery.payload.quantity, accepted_at: delivery.payload.accepted_at }
        : null,
      lot: {
        lot_id: entry.lot_id,
        supplier_id: lot?.supplier_id ?? null,
        category: lot?.category ?? null,
        grade: lot?.grade ?? null,
        declared: lot?.declared ?? null,
        inspections: lot?.inspections ?? [],
        holds: lot?.holds ?? [],
        atp_lines: lot?.atp_lines ?? [],
      },
    };
  }

  tracePayment(paymentId) {
    const view = this.snapshot();
    const payment = view.payments.get(paymentId);
    if (!payment) throw new DomainRejected("PAYMENT_NOT_FOUND", `付款 ${paymentId} 不存在`);
    return {
      payment_id: payment.payment_id,
      amount: payment.amount,
      issued_at: payment.issued_at,
      trace: payment.provenance.map((item) =>
        item.is_reversal
          ? item
          : this.#traceEntry(this.snapshot(), item.entry_id)),
    };
  }

  // ---------- 运营缺口解释 ----------

  explainGap(businessNo) {
    const view = this.snapshot();
    const demand = view.demands.get(businessNo);
    if (!demand) throw new DomainRejected("DEMAND_NOT_FOUND", `业务号 ${businessNo} 未登记`);
    const commitments = [...view.commitments.values()].filter((c) => c.business_no === businessNo);
    const delivered = round2(commitments.reduce((sum, c) => sum + c.delivered, 0));
    const shortClosed = round2(commitments.reduce((sum, c) => sum + c.short_closed, 0));
    const open = round2(commitments.reduce((sum, c) => sum + Math.max(c.open_allocated, 0), 0));
    const promised = round2(commitments.reduce((sum, c) => sum + Math.max(c.quantity - c.confirmed, 0), 0));
    const gap = round2(Math.max(0, demand.quantity - delivered));

    const chain = [];
    for (const commitment of commitments) {
      const lot = view.lots.get(commitment.lot_id);
      const causes = [];
      if (lot) {
        if (lot.buckets.quarantined > 0) causes.push({ code: "QUARANTINE_HOLD", quantity: lot.buckets.quarantined, note: "质量封存中" });
        if (lot.buckets.external_locked > 0) causes.push({ code: "EXTERNAL_LOCK", quantity: lot.buckets.external_locked, note: "被其他市场锁定" });
        if (lot.buckets.short > 0) causes.push({ code: "SHORTAGE", quantity: lot.buckets.short, note: "到货短缺（船期/返港未齐）" });
        if (lot.buckets.lost > 0) causes.push({ code: "LOSS", quantity: lot.buckets.lost, note: "损耗或检验拒收" });
        if (lot.atp.soft_in_transit > 0 || lot.buckets.pending_inspection > 0) {
          causes.push({ code: "NOT_CONVERTIBLE_YET", quantity: lot.atp.soft_in_transit + lot.buckets.pending_inspection, note: "在途或待检，尚非硬额度" });
        }
      }
      chain.push({
        commitment_id: commitment.commitment_id,
        lot_id: commitment.lot_id,
        quantity: commitment.quantity,
        confirmed: commitment.confirmed,
        delivered: commitment.delivered,
        short_closed: commitment.short_closed,
        open_allocated: Math.max(commitment.open_allocated, 0),
        history: commitment.history,
        causes,
      });
    }
    return {
      business_no: businessNo,
      demand_quantity: demand.quantity,
      delivered,
      gap,
      breakdown: { delivered, open_allocated: open, short_closed: shortClosed, promised_unconfirmed: promised, uncovered: round2(gap - open - shortClosed - promised) },
      chain,
    };
  }
}

function stripEnvelope(payload) {
  const { business_no, ...rest } = payload;
  return rest;
}
