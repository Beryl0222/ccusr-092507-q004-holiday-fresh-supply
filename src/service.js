import { validateEvent } from "./contracts.js";

const EPSILON = 1e-9;

// 可承诺来源桶：现货 > 待检 > 在途，承诺时按此顺序消耗并记录来源。
const SOURCE_DRAW_ORDER = ["allocatable", "pending_inspection", "in_transit"];
// 交收时优先消耗尚未落地的来源（在途、待检），保留现货来源支撑剩余承诺。
const DELIVERY_DRAIN_ORDER = ["in_transit", "pending_inspection", "allocatable"];

const COMMITMENT_ACTIVE_STATES = ["offered", "confirmed", "partially_delivered"];

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function parseOffsetMinutes(iso) {
  const match = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

// 按事件自带时区计算当地小时，用于跨午夜费用判定。
function localHour(iso) {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) throw fail("INVALID_TIME", `时间无法解析: ${iso}`);
  return new Date(parsed + parseOffsetMinutes(iso) * 60_000).getUTCHours();
}

function requirePositiveNumber(value, code, message) {
  if (typeof value !== "number" || Number.isNaN(value) || !(value > 0)) {
    throw fail(code, message);
  }
}

function nextId(state, counter, prefix) {
  state.counters[counter] += 1;
  return `${prefix}-${String(state.counters[counter]).padStart(6, "0")}`;
}

/**
 * 双节生鲜承诺清算服务。
 * 所有状态变更都发出符合契约的事件；任何可承诺量都从可解释的批次余额产生；
 * 批次各桶之和恒等于申报数量（数量守恒）。
 */
export function createClearingService({ schema } = {}) {
  const state = {
    lots: new Map(),
    demands: new Map(),
    demandKeys: new Map(),
    receipts: new Map(),
    commitments: new Map(),
    capacities: new Map(),
    entries: new Map(),
    disputes: new Map(),
    ruleSets: [],
    events: [],
    batches: new Map(),
    aggregateVersions: new Map(),
    counters: { event: 0, commitment: 0, dispute: 0, entry: 0, demand: 0 },
  };

  function emit(event_type, aggregate_type, aggregate_id, occurred_at, payload) {
    const key = `${aggregate_type}:${aggregate_id}`;
    const version = (state.aggregateVersions.get(key) ?? 0) + 1;
    state.aggregateVersions.set(key, version);
    const event = {
      event_id: nextId(state, "event", "evt"),
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at,
      version,
      payload,
    };
    if (schema) {
      const issues = validateEvent(event, schema);
      if (issues.length > 0) {
        throw fail("EVENT_CONTRACT_VIOLATION", "事件未通过契约校验", { issues });
      }
    }
    state.events.push(event);
    return event;
  }

  // ---------- 基础查找 ----------

  function getLot(lot_id) {
    const lot = state.lots.get(lot_id);
    if (!lot) throw fail("LOT_NOT_FOUND", `货源批次不存在: ${lot_id}`);
    return lot;
  }

  function getDemand(demand_id) {
    const demand = state.demands.get(demand_id);
    if (!demand) throw fail("DEMAND_NOT_FOUND", `采购需求不存在: ${demand_id}`);
    return demand;
  }

  function getCommitment(commitment_id) {
    const commitment = state.commitments.get(commitment_id);
    if (!commitment) throw fail("COMMITMENT_NOT_FOUND", `承诺不存在: ${commitment_id}`);
    return commitment;
  }

  function getEntry(entry_id) {
    const entry = state.entries.get(entry_id);
    if (!entry) throw fail("ENTRY_NOT_FOUND", `账项不存在: ${entry_id}`);
    return entry;
  }

  // ---------- 批次余额与守恒 ----------

  function bucketTotal(lot) {
    return Object.values(lot.buckets).reduce((total, value) => total + value, 0);
  }

  function assertConservation(lot) {
    if (Math.abs(bucketTotal(lot) - lot.declared) > EPSILON) {
      throw fail("CONSERVATION_VIOLATED", `批次 ${lot.lot_id} 数量守恒被破坏`, {
        declared: lot.declared,
        buckets: { ...lot.buckets },
      });
    }
  }

  // 未承诺、可用于新承诺的余额：现货 + 待检 + 在途。
  function available(lot) {
    return lot.buckets.allocatable + lot.buckets.pending_inspection + lot.buckets.in_transit;
  }

  function deliveredOf(commitment) {
    return commitment.deliveries.reduce((total, delivery) => total + delivery.quantity, 0);
  }

  function undeliveredOf(commitment) {
    return commitment.quantity - commitment.released - deliveredOf(commitment);
  }

  function lotCommitments(lot_id) {
    return [...state.commitments.values()].filter((commitment) => commitment.lot_id === lot_id);
  }

  // ---------- 承诺来源消耗与释放 ----------

  // 成交时从批次余额取货：现货优先，其次待检、在途；来源写入承诺以便追溯与重排。
  function drawSources(lot, quantity) {
    const sources = { allocatable: 0, pending_inspection: 0, in_transit: 0 };
    let remaining = quantity;
    for (const bucket of SOURCE_DRAW_ORDER) {
      const take = Math.min(remaining, lot.buckets[bucket]);
      lot.buckets[bucket] -= take;
      sources[bucket] = take;
      remaining -= take;
    }
    if (remaining > EPSILON) {
      throw fail("INSUFFICIENT_BALANCE", "批次可承诺余额不足", {
        lot_id: lot.lot_id,
        available: available(lot),
        required: quantity,
      });
    }
    return sources;
  }

  // 按指定顺序消耗承诺的来源组成，返回各桶消耗量。
  function drainSources(commitment, quantity, preferredOrder) {
    const drained = { allocatable: 0, pending_inspection: 0, in_transit: 0 };
    let remaining = quantity;
    const order = [...preferredOrder, ...SOURCE_DRAW_ORDER.filter((bucket) => !preferredOrder.includes(bucket))];
    for (const bucket of order) {
      const take = Math.min(remaining, commitment.sources[bucket]);
      commitment.sources[bucket] -= take;
      drained[bucket] = take;
      remaining -= take;
    }
    if (remaining > EPSILON) {
      throw fail("CONSERVATION_VIOLATED", "承诺来源组成与未交收数量不一致", {
        commitment_id: commitment.commitment_id,
      });
    }
    return drained;
  }

  function refreshCommitmentState(commitment) {
    if (commitment.state === "offered" || commitment.state === "stale") return;
    const undelivered = undeliveredOf(commitment);
    if (undelivered <= EPSILON) {
      commitment.state = deliveredOf(commitment) > EPSILON ? "delivered" : "released";
    } else if (deliveredOf(commitment) > EPSILON) {
      commitment.state = "partially_delivered";
    } else {
      commitment.state = "confirmed";
    }
  }

  // 批次余额收缩时，未成交的报价一律作废，必须按新事实重新报价。
  function invalidateOffers(lot_id) {
    for (const commitment of lotCommitments(lot_id)) {
      if (commitment.state === "offered") commitment.state = "stale";
    }
  }

  // ---------- 优先保障规则（冻结版本） ----------

  function currentRules() {
    if (state.ruleSets.length === 0) {
      return { version: 0, rules: { buyer_priority: [], lot_order: "arrival_start_asc" } };
    }
    return state.ruleSets[state.ruleSets.length - 1];
  }

  function buyerRank(buyer_id) {
    const priority = currentRules().rules.buyer_priority ?? [];
    const index = priority.indexOf(buyer_id);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  }

  function lotComparator(left, right) {
    const startDiff = Date.parse(left.arrival_window.start) - Date.parse(right.arrival_window.start);
    if (startDiff !== 0) return startDiff;
    return available(right) - available(left);
  }

  // 重排受害者顺序：优先级最低的买家先承担，其次是最新成交的承诺。
  function victimComparator(left, right) {
    const leftDemand = state.demands.get(left.demand_id);
    const rightDemand = state.demands.get(right.demand_id);
    const rankDiff = buyerRank(rightDemand.buyer_id) - buyerRank(leftDemand.buyer_id);
    if (rankDiff !== 0) return rankDiff;
    return right.seq - left.seq;
  }

  // ---------- 重排 ----------

  // 缺口落到批次上：先扣未承诺余额，再按冻结规则逆序牺牲未交收承诺。
  // source_bucket 限定受害者来源（如短缺只冲击在途来源），已交收部分永不触碰。
  function applyDeficit(lot, fromBucket, toBucket, quantity, cause, occurred_at) {
    const direct = Math.min(quantity, lot.buckets[fromBucket]);
    lot.buckets[fromBucket] -= direct;
    lot.buckets[toBucket] += direct;
    let deficit = quantity - direct;
    if (deficit <= EPSILON) return [];

    const victims = lotCommitments(lot.lot_id)
      .filter((commitment) => COMMITMENT_ACTIVE_STATES.includes(commitment.state)
        && commitment.state !== "offered"
        && undeliveredOf(commitment) > EPSILON
        && commitment.sources[fromBucket] > EPSILON)
      .sort(victimComparator);

    const replanned = [];
    for (const victim of victims) {
      if (deficit <= EPSILON) break;
      const take = Math.min(deficit, undeliveredOf(victim), victim.sources[fromBucket]);
      if (take <= EPSILON) continue;
      releaseToBucket(victim, take, fromBucket, toBucket, cause, occurred_at);
      replanned.push(victim);
      deficit -= take;
    }
    if (deficit > EPSILON) {
      throw fail("DEFICIT_EXCEEDS_SOURCE", "缺口超出批次可承担范围", {
        lot_id: lot.lot_id,
        bucket: fromBucket,
        deficit,
      });
    }
    return replanned;
  }

  // 牺牲承诺的一部分：占用桶转入目标桶（封存/短缺/损耗），数量守恒保持不变。
  function releaseToBucket(commitment, quantity, sourceBucket, targetBucket, cause, occurred_at) {
    const lot = getLot(commitment.lot_id);
    commitment.sources[sourceBucket] -= quantity;
    lot.buckets.reserved -= quantity;
    lot.buckets[targetBucket] += quantity;
    commitment.released += quantity;
    releaseCapacity(commitment, quantity);
    refreshCommitmentState(commitment);
    const demand = getDemand(commitment.demand_id);
    const { replacements, uncovered } = reallocate({
      demand,
      quantity,
      excludeLotId: lot.lot_id,
      cause,
      replannedFrom: commitment.commitment_id,
      agreedUnitPrice: commitment.agreed_unit_price,
      occurred_at,
    });
    emit("COMMITMENT_REPLANNED", "allocation_commitment", commitment.commitment_id, occurred_at, {
      cause,
      released_quantity: quantity,
      demand_id: commitment.demand_id,
      lot_id: lot.lot_id,
      replacements: replacements.map((replacement) => replacement.commitment_id),
      uncovered,
    });
  }

  // 释放但不灭失（船期变化、人工改派）：占用数量按来源组成退回原桶。
  function releaseAndRestore(commitment, quantity, preferredOrder) {
    const lot = getLot(commitment.lot_id);
    const drained = drainSources(commitment, quantity, preferredOrder);
    lot.buckets.reserved -= quantity;
    for (const bucket of SOURCE_DRAW_ORDER) {
      lot.buckets[bucket] += drained[bucket];
    }
    commitment.released += quantity;
    releaseCapacity(commitment, quantity);
    refreshCommitmentState(commitment);
  }

  function releaseCapacity(commitment, quantity) {
    if (!(commitment.capacity_held > 0)) return;
    const demand = state.demands.get(commitment.demand_id);
    const capacity = state.capacities.get(demand.delivery_window_id);
    const freed = Math.min(quantity, commitment.capacity_held);
    commitment.capacity_held -= freed;
    if (capacity) capacity.reserved -= freed;
  }

  // 为重排出的数量在其他批次上重新成交，仍按当前冻结规则选批次。
  function reallocate({ demand, quantity, excludeLotId, cause, replannedFrom, agreedUnitPrice, occurred_at }) {
    const rules = currentRules();
    const capacity = state.capacities.get(demand.delivery_window_id);
    const replacements = [];
    let remaining = quantity;
    const candidates = [...state.lots.values()]
      .filter((lot) => lot.lot_id !== excludeLotId
        && lot.category === demand.category
        && lot.grade === demand.grade
        && available(lot) > EPSILON)
      .sort(lotComparator);
    for (const lot of candidates) {
      if (remaining <= EPSILON) break;
      const capacityLeft = capacity ? capacity.capacity - capacity.reserved : 0;
      if (capacityLeft <= EPSILON) break;
      const take = Math.min(remaining, available(lot), capacityLeft);
      if (take <= EPSILON) continue;
      const commitment = createCommitment({
        demand,
        lot,
        quantity: take,
        state: "confirmed",
        ruleVersion: rules.version,
        sources: drawSources(lot, take),
        agreedUnitPrice,
      });
      lot.buckets.reserved += take;
      commitment.capacity_held = take;
      capacity.reserved += take;
      commitment.replanned_from = replannedFrom;
      commitment.replan_cause = cause;
      emit("COMMITMENT_CONFIRMED", "allocation_commitment", commitment.commitment_id, occurred_at, {
        demand_id: demand.demand_id,
        lot_id: lot.lot_id,
        quantity: take,
        agreed_unit_price: agreedUnitPrice,
        replanned_from: replannedFrom,
      });
      replacements.push(commitment);
      remaining -= take;
    }
    return { replacements, uncovered: remaining };
  }

  function createCommitment({ demand, lot, quantity, state: initialState, ruleVersion, sources = null, agreedUnitPrice = null }) {
    const commitment = {
      commitment_id: nextId(state, "commitment", "com"),
      seq: state.counters.commitment,
      demand_id: demand.demand_id,
      lot_id: lot.lot_id,
      quantity,
      released: 0,
      state: initialState,
      rule_version: ruleVersion,
      sources: sources ?? { allocatable: 0, pending_inspection: 0, in_transit: 0 },
      agreed_unit_price: agreedUnitPrice,
      capacity_held: 0,
      deliveries: [],
      short_settled: false,
      replanned_from: null,
      replan_cause: null,
    };
    state.commitments.set(commitment.commitment_id, commitment);
    return commitment;
  }

  // ---------- 货源批次 ----------

  function declareLot({ lot_id, supplier_id, category, grade, quantity, locked_external = 0, arrival_window, occurred_at }) {
    if (state.lots.has(lot_id)) throw fail("LOT_EXISTS", `货源批次已存在: ${lot_id}`);
    requirePositiveNumber(quantity, "INVALID_QUANTITY", "申报数量必须为正数");
    if (typeof locked_external !== "number" || locked_external < 0 || locked_external >= quantity) {
      throw fail("INVALID_LOCKED", "被其他市场锁定的数量必须不小于 0 且小于申报数量");
    }
    if (!arrival_window || typeof arrival_window.start !== "string" || typeof arrival_window.end !== "string") {
      throw fail("INVALID_WINDOW", "到货窗口必须包含 start 与 end");
    }
    const lot = {
      lot_id,
      supplier_id,
      category,
      grade,
      declared: quantity,
      arrival_window: { start: arrival_window.start, end: arrival_window.end },
      buckets: {
        in_transit: quantity - locked_external,
        pending_inspection: 0,
        allocatable: 0,
        reserved: 0,
        delivered: 0,
        quarantined: 0,
        lost: 0,
        shortage: 0,
        locked_external,
      },
    };
    state.lots.set(lot_id, lot);
    assertConservation(lot);
    emit("LOT_DECLARED", "supply_lot", lot_id, occurred_at, {
      supplier_id,
      category,
      grade,
      quantity,
      locked_external,
      arrival_window: lot.arrival_window,
    });
    return { lot };
  }

  function recordArrival({ lot_id, arrived_quantity, final = false, occurred_at }) {
    const lot = getLot(lot_id);
    if (typeof arrived_quantity !== "number" || arrived_quantity < 0) {
      throw fail("INVALID_QUANTITY", "到货数量必须为非负数");
    }
    const transitBacked = lotCommitments(lot_id).reduce((total, commitment) => total + commitment.sources.in_transit, 0);
    if (arrived_quantity > lot.buckets.in_transit + transitBacked + EPSILON) {
      throw fail("ARRIVAL_EXCEEDS_DECLARED", "到货数量超出批次申报范围", {
        lot_id,
        arrived_quantity,
        declarable: lot.buckets.in_transit + transitBacked,
      });
    }
    const direct = Math.min(arrived_quantity, lot.buckets.in_transit);
    lot.buckets.in_transit -= direct;
    lot.buckets.pending_inspection += direct;
    const overflow = arrived_quantity - direct;
    if (overflow > EPSILON) {
      // 已承诺的在途货物实际到港：只改写承诺来源，不动批次桶。
      reclassifySources(lot, "in_transit", "pending_inspection", overflow, "ARRIVAL_EXCEEDS_DECLARED");
    }
    emit("LOT_ARRIVED", "supply_lot", lot_id, occurred_at, {
      arrived_quantity,
      final,
    });
    if (final) {
      const shortage = lot.buckets.in_transit
        + lotCommitments(lot_id).reduce((total, commitment) => total + commitment.sources.in_transit, 0);
      if (shortage > EPSILON) {
        emit("LOT_SHORTAGE_RECORDED", "supply_lot", lot_id, occurred_at, { quantity: shortage });
        applyDeficit(lot, "in_transit", "shortage", shortage, "ARRIVAL_SHORTAGE", occurred_at);
        invalidateOffers(lot_id);
      }
    }
    assertConservation(lot);
    return { lot };
  }

  // 到货/检验数量超出未承诺余额时，改写已承诺来源的组成（货物状态变化，总量不变）。
  function reclassifySources(lot, fromBucket, toBucket, quantity, errorCode) {
    let remaining = quantity;
    const holders = lotCommitments(lot.lot_id)
      .filter((commitment) => commitment.sources[fromBucket] > EPSILON)
      .sort((left, right) => left.seq - right.seq);
    for (const commitment of holders) {
      if (remaining <= EPSILON) break;
      const take = Math.min(remaining, commitment.sources[fromBucket]);
      commitment.sources[fromBucket] -= take;
      commitment.sources[toBucket] += take;
      remaining -= take;
    }
    if (remaining > EPSILON) {
      throw fail(errorCode, "到货或检验数量超出批次申报范围", {
        lot_id: lot.lot_id,
        excess: remaining,
      });
    }
  }

  function recordInspection({ lot_id, passed_quantity, quarantined_quantity, occurred_at }) {
    const lot = getLot(lot_id);
    if (typeof passed_quantity !== "number" || passed_quantity < 0
      || typeof quarantined_quantity !== "number" || quarantined_quantity < 0) {
      throw fail("INVALID_QUANTITY", "检验数量必须为非负数");
    }
    const pendingBacked = lotCommitments(lot_id).reduce((total, commitment) => total + commitment.sources.pending_inspection, 0);
    if (passed_quantity + quarantined_quantity > lot.buckets.pending_inspection + pendingBacked + EPSILON) {
      throw fail("INSPECTION_EXCEEDS_PENDING", "检验数量超出待检余额", {
        lot_id,
        inspectable: lot.buckets.pending_inspection + pendingBacked,
      });
    }
    // 封存先落：未承诺待检直接封存，不足部分重排已承诺的待检来源。
    const directQuarantine = Math.min(quarantined_quantity, lot.buckets.pending_inspection);
    lot.buckets.pending_inspection -= directQuarantine;
    lot.buckets.quarantined += directQuarantine;
    const quarantineDeficit = quarantined_quantity - directQuarantine;
    if (quarantineDeficit > EPSILON) {
      const victims = lotCommitments(lot_id)
        .filter((commitment) => COMMITMENT_ACTIVE_STATES.includes(commitment.state)
          && commitment.state !== "offered"
          && undeliveredOf(commitment) > EPSILON
          && commitment.sources.pending_inspection > EPSILON)
        .sort(victimComparator);
      let deficit = quarantineDeficit;
      for (const victim of victims) {
        if (deficit <= EPSILON) break;
        const take = Math.min(deficit, undeliveredOf(victim), victim.sources.pending_inspection);
        if (take <= EPSILON) continue;
        releaseToBucket(victim, take, "pending_inspection", "quarantined", "QUALITY_QUARANTINE", occurred_at);
        deficit -= take;
      }
      if (deficit > EPSILON) {
        throw fail("INSPECTION_EXCEEDS_PENDING", "封存数量超出待检余额", { lot_id, deficit });
      }
    }
    // 放行：未承诺待检进入可分配，已承诺待检来源改写为现货来源。
    const directPass = Math.min(passed_quantity, lot.buckets.pending_inspection);
    lot.buckets.pending_inspection -= directPass;
    lot.buckets.allocatable += directPass;
    const passOverflow = passed_quantity - directPass;
    if (passOverflow > EPSILON) {
      reclassifySources(lot, "pending_inspection", "allocatable", passOverflow, "INSPECTION_EXCEEDS_PENDING");
    }
    emit("LOT_INSPECTED", "supply_lot", lot_id, occurred_at, {
      passed_quantity,
      quarantined_quantity,
    });
    if (quarantined_quantity > EPSILON) invalidateOffers(lot_id);
    assertConservation(lot);
    return { lot };
  }

  // 质量封存已放行货物：只重排尚未交收的部分。
  function quarantineLot({ lot_id, quantity, reason, occurred_at }) {
    const lot = getLot(lot_id);
    requirePositiveNumber(quantity, "INVALID_QUANTITY", "封存数量必须为正数");
    if (typeof reason !== "string" || reason.trim() === "") {
      throw fail("REASON_REQUIRED", "质量封存必须说明原因");
    }
    const allocatableBacked = lotCommitments(lot_id).reduce((total, commitment) => total + commitment.sources.allocatable, 0);
    if (quantity > lot.buckets.allocatable + allocatableBacked + EPSILON) {
      throw fail("DEFICIT_EXCEEDS_SOURCE", "封存数量超出批次可承担范围", {
        lot_id,
        seizable: lot.buckets.allocatable + allocatableBacked,
      });
    }
    emit("LOT_QUARANTINED", "supply_lot", lot_id, occurred_at, { quantity, reason });
    applyDeficit(lot, "allocatable", "quarantined", quantity, "QUALITY_QUARANTINE", occurred_at);
    invalidateOffers(lot_id);
    assertConservation(lot);
    return { lot };
  }

  function recordLoss({ lot_id, bucket, quantity, reason, occurred_at }) {
    const lot = getLot(lot_id);
    if (!SOURCE_DRAW_ORDER.includes(bucket)) {
      throw fail("INVALID_BUCKET", "损耗只能发生在在途、待检或可分配余额上");
    }
    requirePositiveNumber(quantity, "INVALID_QUANTITY", "损耗数量必须为正数");
    if (typeof reason !== "string" || reason.trim() === "") {
      throw fail("REASON_REQUIRED", "损耗必须说明原因");
    }
    const bucketBacked = lotCommitments(lot_id).reduce((total, commitment) => total + commitment.sources[bucket], 0);
    if (quantity > lot.buckets[bucket] + bucketBacked + EPSILON) {
      throw fail("DEFICIT_EXCEEDS_SOURCE", "损耗数量超出批次可承担范围", {
        lot_id,
        bucket,
        losable: lot.buckets[bucket] + bucketBacked,
      });
    }
    emit("LOT_LOSS_RECORDED", "supply_lot", lot_id, occurred_at, { bucket, quantity, reason });
    applyDeficit(lot, bucket, "lost", quantity, "LOSS", occurred_at);
    invalidateOffers(lot_id);
    assertConservation(lot);
    return { lot };
  }

  // 船期变化：货物仍在，只重排交付窗口被突破的未交收承诺。
  function updateArrivalWindow({ lot_id, arrival_window, reason, occurred_at }) {
    const lot = getLot(lot_id);
    if (!arrival_window || typeof arrival_window.start !== "string" || typeof arrival_window.end !== "string") {
      throw fail("INVALID_WINDOW", "到货窗口必须包含 start 与 end");
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw fail("REASON_REQUIRED", "船期变化必须说明原因");
    }
    lot.arrival_window = { start: arrival_window.start, end: arrival_window.end };
    emit("LOT_RESCHEDULED", "supply_lot", lot_id, occurred_at, {
      arrival_window: lot.arrival_window,
      reason,
    });
    const victims = lotCommitments(lot_id)
      .filter((commitment) => COMMITMENT_ACTIVE_STATES.includes(commitment.state)
        && commitment.state !== "offered"
        && undeliveredOf(commitment) > EPSILON
        && commitment.sources.in_transit > EPSILON)
      .filter((commitment) => {
        const demand = state.demands.get(commitment.demand_id);
        return Date.parse(demand.needed_by) < Date.parse(arrival_window.end);
      })
      .sort(victimComparator);
    for (const victim of victims) {
      const quantity = Math.min(undeliveredOf(victim), victim.sources.in_transit);
      releaseAndRestore(victim, quantity, ["in_transit"]);
      const demand = getDemand(victim.demand_id);
      const { replacements, uncovered } = reallocate({
        demand,
        quantity,
        excludeLotId: lot_id,
        cause: "SCHEDULE_CHANGE",
        replannedFrom: victim.commitment_id,
        agreedUnitPrice: victim.agreed_unit_price,
        occurred_at,
      });
      emit("COMMITMENT_REPLANNED", "allocation_commitment", victim.commitment_id, occurred_at, {
        cause: "SCHEDULE_CHANGE",
        released_quantity: quantity,
        demand_id: victim.demand_id,
        lot_id,
        replacements: replacements.map((replacement) => replacement.commitment_id),
        uncovered,
      });
    }
    invalidateOffers(lot_id);
    assertConservation(lot);
    return { lot };
  }

  // ---------- 装卸能力 ----------

  function declareHandlingCapacity({ window_id, capacity, occurred_at }) {
    if (state.capacities.has(window_id)) throw fail("CAPACITY_EXISTS", `装卸窗口已登记: ${window_id}`);
    requirePositiveNumber(capacity, "INVALID_CAPACITY", "装卸能力必须为正数");
    const record = { window_id, capacity, reserved: 0 };
    state.capacities.set(window_id, record);
    emit("CAPACITY_DECLARED", "handling_capacity", window_id, occurred_at, { window_id, capacity });
    return { capacity: record };
  }

  // ---------- 采购需求与供应商回执（幂等 + 争议） ----------

  function submitDemand({ business_key, buyer_id, category, grade, quantity, price_range, needed_by, delivery_window_id, occurred_at }) {
    const content = { buyer_id, category, grade, quantity, price_range, needed_by, delivery_window_id };
    const hash = stableStringify(content);
    const existingId = state.demandKeys.get(business_key);
    if (existingId) {
      const existing = state.demands.get(existingId);
      if (existing.content_hash === hash) return { status: "idempotent", demand: existing };
      const dispute = raiseDispute({
        kind: "DEMAND_CONFLICT",
        business_key,
        existing: existing.content,
        incoming: content,
        occurred_at,
      });
      return { status: "dispute", dispute };
    }
    requirePositiveNumber(quantity, "INVALID_QUANTITY", "需求数量必须为正数");
    if (!price_range || typeof price_range.min !== "number" || typeof price_range.max !== "number"
      || price_range.min > price_range.max) {
      throw fail("INVALID_PRICE_RANGE", "价格区间必须包含 min 与 max 且 min 不大于 max");
    }
    const demand = {
      demand_id: nextId(state, "demand", "dem"),
      business_key,
      ...content,
      content_hash: hash,
    };
    state.demands.set(demand.demand_id, demand);
    state.demandKeys.set(business_key, demand.demand_id);
    emit("DEMAND_SUBMITTED", "purchase_demand", demand.demand_id, occurred_at, { business_key, ...content });
    return { status: "created", demand };
  }

  function receiveReceipt({ business_key, lot_id, supplier_id, quantity, occurred_at }) {
    const content = { lot_id, supplier_id, quantity };
    const hash = stableStringify(content);
    const existing = state.receipts.get(business_key);
    if (existing) {
      if (existing.content_hash === hash) return { status: "idempotent", receipt: existing };
      const dispute = raiseDispute({
        kind: "RECEIPT_CONFLICT",
        business_key,
        existing: existing.content,
        incoming: content,
        occurred_at,
      });
      return { status: "dispute", dispute };
    }
    getLot(lot_id);
    const receipt = { receipt_id: `rcp-${business_key}`, business_key, content, content_hash: hash };
    state.receipts.set(business_key, receipt);
    emit("RECEIPT_ACCEPTED", "supply_lot", lot_id, occurred_at, { business_key, supplier_id, quantity });
    return { status: "accepted", receipt };
  }

  function raiseDispute({ kind, business_key, existing, incoming, occurred_at }) {
    const dispute = {
      dispute_id: nextId(state, "dispute", "dis"),
      kind,
      business_key,
      existing,
      incoming,
      status: "open",
    };
    state.disputes.set(dispute.dispute_id, dispute);
    emit("DISPUTE_RAISED", "dispute", dispute.dispute_id, occurred_at, {
      business_key,
      kind,
      existing,
      incoming,
    });
    return dispute;
  }

  // ---------- 优先保障规则 ----------

  function setPriorityRules({ rules, occurred_at }) {
    const version = state.ruleSets.length + 1;
    const frozen = structuredClone(rules);
    state.ruleSets.push({ version, rules: frozen, frozen_at: occurred_at });
    emit("PRIORITY_RULES_FROZEN", "priority_rules", `rules-v${version}`, occurred_at, {
      version,
      rules: frozen,
    });
    return { version };
  }

  // ---------- 承诺：报价、成交、交收、改派 ----------

  // 报价只是计划，不占用批次余额；同一余额可以对多个需求报价，成交闸门保证只成交一份。
  function allocateDemand({ demand_id, quantity, occurred_at }) {
    const demand = getDemand(demand_id);
    const rules = currentRules();
    const promised = [...state.commitments.values()]
      .filter((commitment) => commitment.demand_id === demand_id
        && COMMITMENT_ACTIVE_STATES.includes(commitment.state))
      .reduce((total, commitment) => total + commitment.quantity - commitment.released, 0);
    let remaining = quantity ?? Math.max(0, demand.quantity - promised);
    const offers = [];
    const candidates = [...state.lots.values()]
      .filter((lot) => lot.category === demand.category && lot.grade === demand.grade && available(lot) > EPSILON)
      .sort(lotComparator);
    for (const lot of candidates) {
      if (remaining <= EPSILON) break;
      const take = Math.min(remaining, available(lot));
      const commitment = createCommitment({
        demand,
        lot,
        quantity: take,
        state: "offered",
        ruleVersion: rules.version,
      });
      emit("COMMITMENT_OFFERED", "allocation_commitment", commitment.commitment_id, occurred_at, {
        demand_id,
        lot_id: lot.lot_id,
        quantity: take,
        rule_version: rules.version,
      });
      offers.push(commitment);
      remaining -= take;
    }
    return { offers, unallocated: remaining };
  }

  // 成交是原子闸门：批次余额与装卸能力同时检查、同时占用，并发下只有一方成交。
  function confirmCommitment({ commitment_id, buyer_id, agreed_unit_price, occurred_at }) {
    const commitment = getCommitment(commitment_id);
    if (commitment.state !== "offered") {
      throw fail("INVALID_STATE", "承诺不在可确认状态", { state: commitment.state });
    }
    const demand = getDemand(commitment.demand_id);
    if (buyer_id !== demand.buyer_id) {
      throw fail("BUYER_MISMATCH", "确认方与需求方不一致");
    }
    if (typeof agreed_unit_price !== "number"
      || agreed_unit_price < demand.price_range.min
      || agreed_unit_price > demand.price_range.max) {
      throw fail("PRICE_OUT_OF_RANGE", "约定价超出采购方价格区间");
    }
    const lot = getLot(commitment.lot_id);
    if (available(lot) + EPSILON < commitment.quantity) {
      throw fail("INSUFFICIENT_BALANCE", "批次可承诺余额不足，无法成交", {
        lot_id: lot.lot_id,
        available: available(lot),
        required: commitment.quantity,
      });
    }
    const capacity = state.capacities.get(demand.delivery_window_id);
    if (!capacity) {
      throw fail("CAPACITY_UNDECLARED", `装卸窗口未登记: ${demand.delivery_window_id}`);
    }
    if (capacity.reserved + commitment.quantity > capacity.capacity + EPSILON) {
      throw fail("INSUFFICIENT_CAPACITY", "装卸能力不足，无法成交", {
        window_id: demand.delivery_window_id,
        available: capacity.capacity - capacity.reserved,
        required: commitment.quantity,
      });
    }
    commitment.sources = drawSources(lot, commitment.quantity);
    lot.buckets.reserved += commitment.quantity;
    capacity.reserved += commitment.quantity;
    commitment.capacity_held = commitment.quantity;
    commitment.agreed_unit_price = agreed_unit_price;
    commitment.state = "confirmed";
    commitment.confirmed_at = occurred_at;
    emit("CAPACITY_RESERVED", "allocation_commitment", commitment_id, occurred_at, {
      demand_id: commitment.demand_id,
      window_id: demand.delivery_window_id,
      quantity: commitment.quantity,
    });
    emit("COMMITMENT_CONFIRMED", "allocation_commitment", commitment_id, occurred_at, {
      demand_id: commitment.demand_id,
      lot_id: lot.lot_id,
      quantity: commitment.quantity,
      agreed_unit_price,
    });
    assertConservation(lot);
    return { commitment };
  }

  // 实际交收：delivery_ref 幂等，重传同内容不再记账，异内容报错。
  function recordDelivery({ commitment_id, delivery_ref, quantity, final_unit_price, occurred_at }) {
    const commitment = getCommitment(commitment_id);
    const existing = commitment.deliveries.find((delivery) => delivery.delivery_ref === delivery_ref);
    if (existing) {
      if (existing.quantity === quantity && existing.final_unit_price === final_unit_price) {
        return { status: "idempotent", delivery: existing };
      }
      throw fail("DELIVERY_CONFLICT", "同一交收单号内容不一致", { delivery_ref });
    }
    if (commitment.state !== "confirmed" && commitment.state !== "partially_delivered") {
      throw fail("INVALID_STATE", "承诺未确认，无法交收", { state: commitment.state });
    }
    requirePositiveNumber(quantity, "INVALID_QUANTITY", "交收数量必须为正数");
    if (quantity > undeliveredOf(commitment) + EPSILON) {
      throw fail("INVALID_QUANTITY", "交收数量超出未交收余额", {
        undelivered: undeliveredOf(commitment),
      });
    }
    const lot = getLot(commitment.lot_id);
    lot.buckets.reserved -= quantity;
    lot.buckets.delivered += quantity;
    drainSources(commitment, quantity, DELIVERY_DRAIN_ORDER);
    const delivery = {
      delivery_ref,
      version: commitment.deliveries.length + 1,
      quantity,
      final_unit_price,
      occurred_at,
      settled: false,
    };
    commitment.deliveries.push(delivery);
    refreshCommitmentState(commitment);
    emit("DELIVERY_ACCEPTED", "allocation_commitment", commitment_id, occurred_at, {
      commitment_id,
      delivery_ref,
      version: delivery.version,
      quantity,
      final_unit_price,
      lot_id: commitment.lot_id,
      demand_id: commitment.demand_id,
    });
    assertConservation(lot);
    return { status: "accepted", delivery };
  }

  // 人工改派：必须说明理由；先校验目标批次余额，再释放与占用，数量守恒不被突破。
  function reassignCommitment({ commitment_id, to_lot_id, quantity, reason, operator, occurred_at }) {
    if (typeof reason !== "string" || reason.trim() === "") {
      throw fail("REASON_REQUIRED", "人工改派必须说明理由");
    }
    if (typeof operator !== "string" || operator.trim() === "") {
      throw fail("OPERATOR_REQUIRED", "人工改派必须登记经办人");
    }
    const commitment = getCommitment(commitment_id);
    if (commitment.state !== "confirmed" && commitment.state !== "partially_delivered") {
      throw fail("INVALID_STATE", "仅已确认承诺可改派", { state: commitment.state });
    }
    const undelivered = undeliveredOf(commitment);
    const move = quantity ?? undelivered;
    requirePositiveNumber(move, "INVALID_QUANTITY", "改派数量必须为正数");
    if (move > undelivered + EPSILON) {
      throw fail("INVALID_QUANTITY", "改派数量超出未交收余额", { undelivered });
    }
    const demand = getDemand(commitment.demand_id);
    const fromLot = getLot(commitment.lot_id);
    const toLot = getLot(to_lot_id);
    if (toLot.category !== demand.category || toLot.grade !== demand.grade) {
      throw fail("GRADE_MISMATCH", "改派目标批次品类等级不符");
    }
    if (available(toLot) + EPSILON < move) {
      throw fail("INSUFFICIENT_BALANCE", "目标批次余额不足，改派会突破数量守恒", {
        to_lot_id,
        available: available(toLot),
        required: move,
      });
    }
    releaseAndRestore(commitment, move, SOURCE_DRAW_ORDER);
    const replacement = createCommitment({
      demand,
      lot: toLot,
      quantity: move,
      state: "confirmed",
      ruleVersion: commitment.rule_version,
      sources: drawSources(toLot, move),
      agreedUnitPrice: commitment.agreed_unit_price,
    });
    toLot.buckets.reserved += move;
    replacement.capacity_held = move;
    const capacity = state.capacities.get(demand.delivery_window_id);
    if (capacity) capacity.reserved += move;
    replacement.reassigned_from = commitment.commitment_id;
    emit("COMMITMENT_REASSIGNED", "allocation_commitment", replacement.commitment_id, occurred_at, {
      from_lot_id: fromLot.lot_id,
      to_lot_id,
      quantity: move,
      reason,
      operator,
      reassigned_from: commitment.commitment_id,
      demand_id: demand.demand_id,
    });
    assertConservation(fromLot);
    assertConservation(toLot);
    return { released: commitment, replacement };
  }

  // ---------- 清算 ----------

  // 账项候选：货款、跨午夜费用、短交赔付、退补价，全部以实际交收版本为据。
  function computeDueEntries(period_id, as_of, fee_config) {
    const due = [];
    const asOfMs = Date.parse(as_of);
    for (const commitment of state.commitments.values()) {
      if (!["confirmed", "partially_delivered", "delivered"].includes(commitment.state)) continue;
      const demand = state.demands.get(commitment.demand_id);
      const lot = state.lots.get(commitment.lot_id);
      const base = {
        commitment,
        demand,
        lot,
      };
      const unsettled = commitment.deliveries.filter(
        (delivery) => !delivery.settled && Date.parse(delivery.occurred_at) <= asOfMs,
      );
      if (unsettled.length > 0) {
        const refs = unsettled.map((delivery) => ({ delivery_ref: delivery.delivery_ref, version: delivery.version }));
        const goodsAmount = unsettled.reduce(
          (total, delivery) => total + delivery.quantity * delivery.final_unit_price,
          0,
        );
        due.push({
          ...base,
          key: `${period_id}:${commitment.commitment_id}:goods:${unsettled.map((delivery) => delivery.version).join("+")}`,
          kind: "goods",
          amount: goodsAmount,
          delivery_refs: refs,
          deliveries: unsettled,
        });
        const nightQuantity = unsettled
          .filter((delivery) => {
            const hour = localHour(delivery.occurred_at);
            return hour >= fee_config.night_window.start_hour && hour < fee_config.night_window.end_hour;
          })
          .reduce((total, delivery) => total + delivery.quantity, 0);
        if (nightQuantity > EPSILON) {
          due.push({
            ...base,
            key: `${period_id}:${commitment.commitment_id}:night:${unsettled.map((delivery) => delivery.version).join("+")}`,
            kind: "night_fee",
            amount: nightQuantity * fee_config.night_fee_per_unit,
            delivery_refs: refs,
            deliveries: unsettled,
          });
        }
        const adjustment = unsettled.reduce(
          (total, delivery) => total + (delivery.final_unit_price - commitment.agreed_unit_price) * delivery.quantity,
          0,
        );
        if (Math.abs(adjustment) > EPSILON) {
          due.push({
            ...base,
            key: `${period_id}:${commitment.commitment_id}:adjust:${unsettled.map((delivery) => delivery.version).join("+")}`,
            kind: "price_adjustment",
            amount: adjustment,
            delivery_refs: refs,
            deliveries: unsettled,
          });
        }
      }
      const undelivered = undeliveredOf(commitment);
      if (undelivered > EPSILON && !commitment.short_settled && Date.parse(demand.needed_by) <= asOfMs) {
        due.push({
          ...base,
          key: `${period_id}:${commitment.commitment_id}:short`,
          kind: "short_penalty",
          amount: undelivered * fee_config.short_penalty_per_unit,
          delivery_refs: [],
          deliveries: [],
        });
      }
    }
    return due.sort((left, right) => left.key.localeCompare(right.key));
  }

  function postEntry(period_id, item, occurred_at) {
    const entry = {
      entry_id: nextId(state, "entry", "ent"),
      period_id,
      kind: item.kind,
      amount: Math.round(item.amount * 1e6) / 1e6,
      commitment_id: item.commitment.commitment_id,
      demand_id: item.demand.demand_id,
      buyer_id: item.demand.buyer_id,
      supplier_id: item.lot.supplier_id,
      lot_id: item.lot.lot_id,
      delivery_refs: item.delivery_refs,
      status: "posted",
      reverses: null,
      created_at: occurred_at,
    };
    state.entries.set(entry.entry_id, entry);
    for (const delivery of item.deliveries) delivery.settled = true;
    if (item.kind === "short_penalty") item.commitment.short_settled = true;
    emit("SETTLEMENT_POSTED", "settlement_entry", entry.entry_id, occurred_at, {
      period_id,
      amount: entry.amount,
      kind: entry.kind,
      commitment_id: entry.commitment_id,
      buyer_id: entry.buyer_id,
      supplier_id: entry.supplier_id,
      delivery_refs: entry.delivery_refs,
    });
    return entry;
  }

  // 财务批处理：按确定顺序过账，limit 模拟中断；账项键幂等，中断后继续未完成账项。
  function runSettlementBatch({ period_id, as_of, fee_config, limit }) {
    const due = computeDueEntries(period_id, as_of, fee_config);
    const batch = state.batches.get(period_id) ?? { posted: new Set(), done: false };
    let processed = 0;
    const entries = [];
    for (const item of due) {
      if (batch.posted.has(item.key)) continue;
      if (limit != null && processed >= limit) break;
      entries.push(postEntry(period_id, item, as_of));
      batch.posted.add(item.key);
      processed += 1;
    }
    batch.done = due.every((item) => batch.posted.has(item.key));
    state.batches.set(period_id, batch);
    return {
      period_id,
      processed,
      done: batch.done,
      remaining: due.filter((item) => !batch.posted.has(item.key)).length,
      entries,
    };
  }

  // 已出账周期不改动原账项，只通过冲正调整。
  function reverseEntry({ entry_id, reason, occurred_at }) {
    const entry = getEntry(entry_id);
    if (entry.status !== "posted") {
      throw fail("INVALID_STATE", "仅已出账账项可冲正", { status: entry.status });
    }
    if (entry.reverses) {
      throw fail("INVALID_STATE", "冲正账项不可再次冲正");
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      throw fail("REASON_REQUIRED", "冲正必须说明理由");
    }
    entry.status = "reversed";
    const reversal = {
      entry_id: nextId(state, "entry", "ent"),
      period_id: entry.period_id,
      kind: entry.kind,
      amount: -entry.amount,
      commitment_id: entry.commitment_id,
      demand_id: entry.demand_id,
      buyer_id: entry.buyer_id,
      supplier_id: entry.supplier_id,
      lot_id: entry.lot_id,
      delivery_refs: entry.delivery_refs,
      status: "posted",
      reverses: entry.entry_id,
      created_at: occurred_at,
    };
    state.entries.set(reversal.entry_id, reversal);
    emit("SETTLEMENT_REVERSED", "settlement_entry", reversal.entry_id, occurred_at, {
      period_id: reversal.period_id,
      amount: reversal.amount,
      kind: reversal.kind,
      reverses: entry.entry_id,
      reason,
    });
    return { reversal, original: entry };
  }

  // ---------- 运营与追溯 ----------

  // 缺口解释：让运营看见缺口为何形成——每个候选批次的余额去向逐桶列出。
  function explainGap(demand_id) {
    const demand = getDemand(demand_id);
    const commitments = [...state.commitments.values()].filter(
      (commitment) => commitment.demand_id === demand_id,
    );
    const confirmedActive = commitments
      .filter((commitment) => ["confirmed", "partially_delivered", "delivered"].includes(commitment.state))
      .reduce((total, commitment) => total + commitment.quantity - commitment.released, 0);
    const offered = commitments
      .filter((commitment) => commitment.state === "offered")
      .reduce((total, commitment) => total + commitment.quantity, 0);
    const delivered = commitments.reduce((total, commitment) => total + deliveredOf(commitment), 0);
    const gap = Math.max(0, demand.quantity - confirmedActive);
    const lots = [...state.lots.values()]
      .filter((lot) => lot.category === demand.category && lot.grade === demand.grade)
      .map((lot) => ({
        lot_id: lot.lot_id,
        supplier_id: lot.supplier_id,
        buckets: { ...lot.buckets },
        available: available(lot),
      }));
    const capacity = state.capacities.get(demand.delivery_window_id);
    const notes = [];
    for (const lot of lots) {
      const buckets = lot.buckets;
      const parts = [];
      if (buckets.allocatable > EPSILON) parts.push(`现货可分配 ${buckets.allocatable}`);
      if (buckets.in_transit > EPSILON) parts.push(`在途 ${buckets.in_transit}`);
      if (buckets.pending_inspection > EPSILON) parts.push(`待检 ${buckets.pending_inspection}`);
      if (buckets.quarantined > EPSILON) parts.push(`质量封存 ${buckets.quarantined}`);
      if (buckets.lost > EPSILON) parts.push(`损耗 ${buckets.lost}`);
      if (buckets.shortage > EPSILON) parts.push(`到货短缺 ${buckets.shortage}`);
      if (buckets.locked_external > EPSILON) parts.push(`被其他市场锁定 ${buckets.locked_external}`);
      if (buckets.reserved > EPSILON) parts.push(`已被占用 ${buckets.reserved}`);
      notes.push(`批次 ${lot.lot_id}：${parts.length > 0 ? parts.join("、") : "无余额"}`);
    }
    if (capacity) {
      notes.push(`装卸窗口 ${capacity.window_id}：能力 ${capacity.capacity}，已占用 ${capacity.reserved}，剩余 ${capacity.capacity - capacity.reserved}`);
    }
    notes.push(`需求 ${demand.quantity}，已成交 ${confirmedActive}，已交收 ${delivered}，缺口 ${gap}`);
    return {
      demand_id,
      required: demand.quantity,
      offered,
      confirmed: confirmedActive,
      delivered,
      gap,
      lots,
      notes,
    };
  }

  // 任意一笔付款都能追到货源、检验、占用和交收事实。
  function tracePayment(entry_id) {
    const entry = getEntry(entry_id);
    const commitment = getCommitment(entry.commitment_id);
    const demand = state.demands.get(entry.demand_id);
    const lot = getLot(entry.lot_id);
    const lotEvents = state.events.filter((event) => event.aggregate_id === lot.lot_id);
    const commitmentEvents = state.events.filter((event) => event.aggregate_id === commitment.commitment_id);
    return {
      entry,
      commitment,
      demand,
      lot: {
        lot_id: lot.lot_id,
        supplier_id: lot.supplier_id,
        category: lot.category,
        grade: lot.grade,
        declared: lot.declared,
        buckets: { ...lot.buckets },
      },
      inspections: lotEvents.filter((event) => ["LOT_INSPECTED", "LOT_QUARANTINED"].includes(event.event_type)),
      reservations: commitmentEvents.filter((event) => ["CAPACITY_RESERVED", "COMMITMENT_CONFIRMED"].includes(event.event_type)),
      deliveries: commitment.deliveries.map((delivery) => ({ ...delivery })),
    };
  }

  // 全局不变量：批次守恒、占用桶与承诺一致、装卸能力与承诺一致、来源组成一致。
  function verifyInvariants() {
    for (const lot of state.lots.values()) {
      assertConservation(lot);
      const reserved = lotCommitments(lot.lot_id)
        .filter((commitment) => ["confirmed", "partially_delivered"].includes(commitment.state))
        .reduce((total, commitment) => total + undeliveredOf(commitment), 0);
      if (Math.abs(lot.buckets.reserved - reserved) > EPSILON) {
        throw fail("CONSERVATION_VIOLATED", `批次 ${lot.lot_id} 占用桶与承诺不一致`, {
          bucket: lot.buckets.reserved,
          commitments: reserved,
        });
      }
    }
    for (const commitment of state.commitments.values()) {
      if (!["confirmed", "partially_delivered"].includes(commitment.state)) continue;
      const sourceTotal = SOURCE_DRAW_ORDER.reduce((total, bucket) => total + commitment.sources[bucket], 0);
      if (Math.abs(sourceTotal - undeliveredOf(commitment)) > EPSILON) {
        throw fail("CONSERVATION_VIOLATED", `承诺 ${commitment.commitment_id} 来源组成与未交收数量不一致`);
      }
    }
    for (const capacity of state.capacities.values()) {
      const held = [...state.commitments.values()]
        .filter((commitment) => commitment.capacity_held > 0
          && state.demands.get(commitment.demand_id).delivery_window_id === capacity.window_id)
        .reduce((total, commitment) => total + commitment.capacity_held, 0);
      if (Math.abs(capacity.reserved - held) > EPSILON) {
        throw fail("CONSERVATION_VIOLATED", `装卸窗口 ${capacity.window_id} 占用与承诺不一致`);
      }
    }
    return true;
  }

  return {
    declareLot,
    recordArrival,
    recordInspection,
    quarantineLot,
    recordLoss,
    updateArrivalWindow,
    declareHandlingCapacity,
    submitDemand,
    receiveReceipt,
    setPriorityRules,
    allocateDemand,
    confirmCommitment,
    recordDelivery,
    reassignCommitment,
    runSettlementBatch,
    reverseEntry,
    explainGap,
    tracePayment,
    verifyInvariants,
    getLotBalance: (lot_id) => {
      const lot = getLot(lot_id);
      return {
        lot_id: lot.lot_id,
        declared: lot.declared,
        buckets: { ...lot.buckets },
        available: available(lot),
      };
    },
    getDemand: (demand_id) => getDemand(demand_id),
    getCommitment: (commitment_id) => getCommitment(commitment_id),
    getEntry: (entry_id) => getEntry(entry_id),
    listEntries: (period_id) => [...state.entries.values()].filter((entry) => entry.period_id === period_id),
    listDisputes: () => [...state.disputes.values()],
    listEvents: () => [...state.events],
  };
}
