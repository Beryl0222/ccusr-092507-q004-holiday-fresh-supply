import { projectLot, projectCapacity } from "./quantities.js";

// 从全局事件日志重建服务读模型。所有写操作经同一把批次互斥锁串行化，
// 因此跨聚合重建只需按追加顺序回放即可得到一致快照。
export function buildReadModel(events) {
  const lots = new Map();
  const capacities = new Map();
  const demands = new Map();
  const commitments = new Map();
  const entries = new Map();
  const periods = new Map();
  const payments = new Map();
  const disputes = [];
  const rounds = new Map();

  const lotEvents = new Map();
  const capEvents = new Map();

  function commitment(id) {
    if (!commitments.has(id)) {
      commitments.set(id, {
        commitment_id: id,
        lot_id: null,
        demand_id: null,
        business_no: null,
        quantity: 0,
        price: null,
        arrival_window: null,
        freeze_version: null,
        ack: null,
        status: "proposed",
        confirmed: 0,
        released: 0,
        short_closed: 0,
        delivered: 0,
        parent_id: null,
        history: [],
      });
    }
    return commitments.get(id);
  }

  function bindLot(event) {
    if (event.event_type === "ALLOCATION_REARRANGED") {
      for (const item of event.payload?.items ?? []) {
        for (const lotId of new Set([item.from_lot_id, item.to_lot_id])) {
          if (lotId && !lotEvents.has(lotId)) lotEvents.set(lotId, []);
          if (lotId) lotEvents.get(lotId).push(event);
        }
      }
      return;
    }
    const lotId = event.aggregate_type === "supply_lot"
      ? event.aggregate_id
      : (event.payload?.lot_id ?? null);
    if (!lotId) return;
    if (!lotEvents.has(lotId)) lotEvents.set(lotId, []);
    lotEvents.get(lotId).push(event);
  }

  for (const event of events) {
    const p = event.payload ?? {};
    bindLot(event);

    if (event.aggregate_type === "handling_capacity") {
      const windowId = p.window_id ?? event.aggregate_id;
      if (!capEvents.has(windowId)) capEvents.set(windowId, []);
      capEvents.get(windowId).push(event);
    }

    switch (event.event_type) {
      case "DEMAND_REGISTERED": {
        demands.set(p.business_no, {
          business_no: p.business_no,
          demand_id: event.aggregate_id,
          category: p.category,
          grade: p.grade,
          unit: p.unit,
          quantity: p.quantity,
          window: p.window,
          max_price: p.max_price,
          status: "open",
        });
        break;
      }
      case "PRIORITY_FROZEN": {
        rounds.set(p.round_id, {
          round_id: p.round_id,
          freeze_version: p.freeze_version,
          criteria: p.criteria,
          ranking: p.ranking,
          frozen_at: event.occurred_at,
        });
        break;
      }
      case "COMMITMENT_PROPOSED": {
        const c = commitment(event.aggregate_id);
        c.lot_id = p.lot_id;
        c.demand_id = p.demand_id;
        c.business_no = p.business_no;
        c.quantity = p.quantity;
        c.price = p.price;
        c.arrival_window = p.arrival_window;
        c.status = "proposed";
        c.history.push({ event: event.event_type, at: event.occurred_at });
        break;
      }
      case "COMMITMENT_ACKED": {
        const c = commitment(p.commitment_id);
        c.ack = p.ack;
        break;
      }
      case "ALLOCATION_CONFIRMED": {
        const c = commitment(p.commitment_id);
        c.confirmed += p.quantity;
        c.freeze_version = p.freeze_version ?? c.freeze_version;
        c.status = "confirmed";
        c.history.push({ event: event.event_type, quantity: p.quantity, at: event.occurred_at, rearranged: Boolean(p.rearranged) });
        break;
      }
      case "ALLOCATION_REARRANGED": {
        for (const item of p.items ?? []) {
          if (item.action === "moved") {
            const parent = commitment(item.commitment_id);
            const splitId = item.split_commitment_id ?? item.commitment_id;
            if (splitId !== item.commitment_id) {
              const child = commitment(splitId);
              child.lot_id = item.to_lot_id;
              child.demand_id = parent.demand_id;
              child.business_no = parent.business_no;
              child.price = parent.price;
              child.arrival_window = parent.arrival_window;
              child.freeze_version = parent.freeze_version;
              child.quantity += item.quantity;
              child.confirmed += item.quantity;
              child.status = "confirmed";
              child.parent_id = item.commitment_id;
              if (item.stage === "promise") {
                // 拆出的是父承诺尚未确认的部分：父承诺量相应缩减（物理占用从未在源批次建立）。
                parent.quantity -= item.quantity;
                parent.history.push({ event: "SPLIT_PROMISE_OUT", to: splitId, to_lot_id: item.to_lot_id, quantity: item.quantity });
              } else {
                parent.moved_out = (parent.moved_out ?? 0) + item.quantity;
                parent.history.push({ event: "SPLIT_MOVED_OUT", to: splitId, to_lot_id: item.to_lot_id, quantity: item.quantity });
              }
              child.history.push({ event: "SPLIT_MOVED_IN", from_lot_id: item.from_lot_id, stage: item.stage ?? "allocated", quantity: item.quantity });
            } else {
              parent.history.push({ event: "RECOVERED_ON_LOT", lot_id: item.to_lot_id, quantity: item.quantity });
            }
          } else if (item.action === "short_closed") {
            const c = commitment(item.commitment_id);
            if (item.stage === "promise") {
              // 未确认承诺部分无法补位：直接缩减承诺量，不再进入占用。
              c.quantity -= item.quantity;
              c.history.push({ event: "PROMISE_SHORT_CLOSED", quantity: item.quantity, reason: item.reason });
            } else {
              c.short_closed += item.quantity;
              c.status = "shortfall";
              c.history.push({ event: "SHORT_CLOSED", quantity: item.quantity, reason: item.reason });
            }
          }
        }
        break;
      }
      case "ALLOCATION_REASSIGNED": {
        const from = commitment(p.commitment_id);
        const targetId = event.aggregate_id;
        const target = commitment(targetId);
        target.lot_id = from.lot_id;
        target.demand_id = p.to_demand_id;
        target.business_no = p.to_business_no ?? null;
        target.quantity = p.quantity;
        target.price = from.price;
        target.arrival_window = from.arrival_window;
        target.confirmed = p.quantity;
        target.status = "confirmed";
        target.parent_id = p.commitment_id;
        target.freeze_version = from.freeze_version;
        from.quantity -= p.quantity;
        from.confirmed -= p.quantity;
        from.history.push({ event: "REASSIGNED_OUT", to: targetId, quantity: p.quantity, reason: p.reason, operator_id: p.operator_id });
        target.history.push({ event: "REASSIGNED_IN", from: p.commitment_id, quantity: p.quantity, reason: p.reason, operator_id: p.operator_id });
        break;
      }
      case "ALLOCATION_RELEASED": {
        const c = commitment(p.commitment_id);
        c.released += p.quantity;
        break;
      }
      case "ALLOCATION_SHORTFALL_CLOSED": {
        const c = commitment(p.commitment_id);
        c.short_closed += p.quantity;
        c.status = "shortfall";
        break;
      }
      case "DELIVERY_ACCEPTED": {
        const c = commitment(p.commitment_id);
        c.delivered += p.quantity;
        if (c.delivered + c.short_closed + c.released >= c.quantity - 1e-9) c.status = "delivered";
        break;
      }
      case "SETTLEMENT_POSTED": {
        entries.set(event.aggregate_id, {
          entry_id: event.aggregate_id,
          period_id: p.period_id,
          delivery_id: p.delivery_id,
          commitment_id: p.commitment_id,
          lot_id: p.lot_id,
          demand_id: p.demand_id,
          business_no: p.business_no,
          freeze_version: p.freeze_version,
          lines: p.lines,
          amount: p.amount,
          reversed: false,
          reversal_entry_id: null,
          posted_at: event.occurred_at,
        });
        break;
      }
      case "SETTLEMENT_REVERSED": {
        entries.set(event.aggregate_id, {
          entry_id: event.aggregate_id,
          period_id: p.period_id,
          original_entry_id: p.original_entry_id,
          delivery_id: p.delivery_id,
          amount: p.amount,
          reason: p.reason,
          is_reversal: true,
          posted_at: event.occurred_at,
        });
        const original = entries.get(p.original_entry_id);
        if (original) {
          original.reversed = true;
          original.reversal_entry_id = event.aggregate_id;
        }
        break;
      }
      case "PERIOD_CLOSED":
        periods.set(p.period_id, { period_id: p.period_id, closed_at: event.occurred_at });
        break;
      case "PAYMENT_ISSUED":
        payments.set(p.payment_id, {
          payment_id: p.payment_id,
          settlement_entry_ids: p.settlement_entry_ids,
          amount: p.amount,
          provenance: p.provenance,
          issued_at: event.occurred_at,
        });
        break;
      case "DISPUTE_OPENED":
        disputes.push({
          dispute_id: event.aggregate_id,
          business_no: p.business_no,
          kind: p.kind,
          reason: p.reason,
          fingerprint_existing: p.fingerprint_existing ?? null,
          fingerprint_incoming: p.fingerprint_incoming ?? null,
          status: "open",
          opened_at: event.occurred_at,
        });
        break;
      case "DISPUTE_RESOLVED": {
        const dispute = disputes.find((item) => item.dispute_id === p.dispute_id);
        if (dispute) {
          dispute.status = "resolved";
          dispute.resolution = p.resolution;
        }
        break;
      }
      default:
        break;
    }
  }

  for (const [lotId, lotEventList] of lotEvents) {
    const meta = lotEventList.find((event) => event.event_type === "LOT_DECLARED");
    lots.set(lotId, {
      lot_id: lotId,
      ...(meta ? { category: meta.payload.category, grade: meta.payload.grade, unit: meta.payload.unit, price_range: meta.payload.price_range, supplier_id: meta.payload.supplier_id } : {}),
      ...projectLot(lotEventList, lotId),
    });
  }
  for (const [windowId, list] of capEvents) {
    if (!list.some((event) => event.event_type === "CAPACITY_DECLARED")) continue;
    capacities.set(windowId, projectCapacity(list));
  }
  for (const c of commitments.values()) {
    c.open_allocated = round9(c.confirmed - c.delivered - c.released - c.short_closed - (c.moved_out ?? 0));
  }

  return { lots, capacities, demands, commitments, entries, periods, payments, disputes, rounds };
}

const round9 = (value) => (Math.abs(value) < 1e-9 ? 0 : value);
