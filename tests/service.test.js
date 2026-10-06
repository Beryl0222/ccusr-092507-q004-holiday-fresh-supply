import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/contracts.js";
import { createClearingService } from "../src/service.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

const T0 = "2026-09-24T08:00:00+08:00";
const WINDOW = { start: "2026-09-30T08:00:00+08:00", end: "2026-09-30T20:00:00+08:00" };
const LATE_WINDOW = { start: "2026-10-01T08:00:00+08:00", end: "2026-10-01T20:00:00+08:00" };
const FEE_CONFIG = {
  night_window: { start_hour: 0, end_hour: 6 },
  night_fee_per_unit: 0.5,
  short_penalty_per_unit: 2,
};

function makeService() {
  return createClearingService({ schema });
}

// 常见前置：一个已放行现货批次 + 一个装卸窗口。
function lotReady(service, lot_id, quantity, window = WINDOW) {
  service.declareLot({
    lot_id,
    supplier_id: "supplier-1",
    category: "蔬菜",
    grade: "一级",
    quantity,
    arrival_window: window,
    occurred_at: T0,
  });
  service.recordArrival({ lot_id, arrived_quantity: quantity, final: true, occurred_at: "2026-09-30T09:00:00+08:00" });
  service.recordInspection({ lot_id, passed_quantity: quantity, quarantined_quantity: 0, occurred_at: "2026-09-30T10:00:00+08:00" });
}

function demandReady(service, { key, buyer = "buyer-1", quantity, min = 10, max = 20, neededBy = "2026-10-05T00:00:00+08:00", window = "w-1001" }) {
  const result = service.submitDemand({
    business_key: key,
    buyer_id: buyer,
    category: "蔬菜",
    grade: "一级",
    quantity,
    price_range: { min, max },
    needed_by: neededBy,
    delivery_window_id: window,
    occurred_at: T0,
  });
  assert.equal(result.status, "created");
  return result.demand;
}

function confirmed(service, demand, quantity, price = 15) {
  const { offers } = service.allocateDemand({ demand_id: demand.demand_id, occurred_at: T0 });
  const offer = offers.find((item) => item.quantity === quantity) ?? offers[0];
  service.confirmCommitment({
    commitment_id: offer.commitment_id,
    buyer_id: demand.buyer_id,
    agreed_unit_price: price,
    occurred_at: T0,
  });
  return offer;
}

test("批次余额可解释：申报、到货、检验、成交、交收逐步守恒", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-1",
    supplier_id: "supplier-1",
    category: "蔬菜",
    grade: "一级",
    quantity: 100,
    locked_external: 20,
    arrival_window: WINDOW,
    occurred_at: T0,
  });
  let balance = service.getLotBalance("lot-1");
  assert.deepEqual(
    { in_transit: balance.buckets.in_transit, locked: balance.buckets.locked_external },
    { in_transit: 80, locked: 20 },
  );

  service.recordArrival({ lot_id: "lot-1", arrived_quantity: 80, final: true, occurred_at: "2026-09-30T09:00:00+08:00" });
  service.recordInspection({ lot_id: "lot-1", passed_quantity: 70, quarantined_quantity: 10, occurred_at: "2026-09-30T10:00:00+08:00" });
  balance = service.getLotBalance("lot-1");
  assert.equal(balance.buckets.allocatable, 70);
  assert.equal(balance.buckets.quarantined, 10);

  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 40 });
  const offer = confirmed(service, demand, 40);
  balance = service.getLotBalance("lot-1");
  assert.equal(balance.buckets.reserved, 40);
  assert.equal(balance.buckets.allocatable, 30);
  assert.deepEqual(service.getCommitment(offer.commitment_id).sources, {
    allocatable: 40,
    pending_inspection: 0,
    in_transit: 0,
  });

  service.recordDelivery({
    commitment_id: offer.commitment_id,
    delivery_ref: "del-1",
    quantity: 25,
    final_unit_price: 15,
    occurred_at: "2026-10-01T08:00:00+08:00",
  });
  balance = service.getLotBalance("lot-1");
  assert.equal(balance.buckets.delivered, 25);
  assert.equal(balance.buckets.reserved, 15);
  assert.equal(service.verifyInvariants(), true);
});

test("采购需求按业务号幂等，异内容进入争议", () => {
  const service = makeService();
  const first = demandReady(service, { key: "D-100", quantity: 40 });
  const retry = service.submitDemand({
    business_key: "D-100",
    buyer_id: "buyer-1",
    category: "蔬菜",
    grade: "一级",
    quantity: 40,
    price_range: { min: 10, max: 20 },
    needed_by: "2026-10-05T00:00:00+08:00",
    delivery_window_id: "w-1001",
    occurred_at: T0,
  });
  assert.equal(retry.status, "idempotent");
  assert.equal(retry.demand.demand_id, first.demand_id);

  const conflict = service.submitDemand({
    business_key: "D-100",
    buyer_id: "buyer-1",
    category: "蔬菜",
    grade: "一级",
    quantity: 99,
    price_range: { min: 10, max: 20 },
    needed_by: "2026-10-05T00:00:00+08:00",
    delivery_window_id: "w-1001",
    occurred_at: T0,
  });
  assert.equal(conflict.status, "dispute");
  assert.equal(conflict.dispute.kind, "DEMAND_CONFLICT");
  assert.equal(service.listDisputes().length, 1);
  assert.equal(
    service.listEvents().filter((event) => event.event_type === "DEMAND_SUBMITTED").length,
    1,
  );
  assert.equal(
    service.listEvents().filter((event) => event.event_type === "DISPUTE_RAISED").length,
    1,
  );
});

test("供应商回执补传幂等，异内容进入争议", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-1",
    supplier_id: "supplier-1",
    category: "蔬菜",
    grade: "一级",
    quantity: 100,
    arrival_window: WINDOW,
    occurred_at: T0,
  });
  const first = service.receiveReceipt({ business_key: "R-1", lot_id: "lot-1", supplier_id: "supplier-1", quantity: 60, occurred_at: T0 });
  assert.equal(first.status, "accepted");
  const retry = service.receiveReceipt({ business_key: "R-1", lot_id: "lot-1", supplier_id: "supplier-1", quantity: 60, occurred_at: T0 });
  assert.equal(retry.status, "idempotent");
  const conflict = service.receiveReceipt({ business_key: "R-1", lot_id: "lot-1", supplier_id: "supplier-1", quantity: 61, occurred_at: T0 });
  assert.equal(conflict.status, "dispute");
  assert.equal(conflict.dispute.kind, "RECEIPT_CONFLICT");
  assert.equal(
    service.listEvents().filter((event) => event.event_type === "RECEIPT_ACCEPTED").length,
    1,
  );
});

test("两个采购方并发确认最后一份额度时只允许一个成交", () => {
  const service = makeService();
  lotReady(service, "lot-1", 10);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demandA = demandReady(service, { key: "D-A", buyer: "buyer-a", quantity: 10 });
  const demandB = demandReady(service, { key: "D-B", buyer: "buyer-b", quantity: 10 });

  const offerA = service.allocateDemand({ demand_id: demandA.demand_id, occurred_at: T0 }).offers[0];
  const offerB = service.allocateDemand({ demand_id: demandB.demand_id, occurred_at: T0 }).offers[0];
  assert.equal(offerA.quantity, 10);
  assert.equal(offerB.quantity, 10);

  service.confirmCommitment({ commitment_id: offerA.commitment_id, buyer_id: "buyer-a", agreed_unit_price: 15, occurred_at: T0 });
  assert.throws(
    () => service.confirmCommitment({ commitment_id: offerB.commitment_id, buyer_id: "buyer-b", agreed_unit_price: 15, occurred_at: T0 }),
    (error) => error.code === "INSUFFICIENT_BALANCE",
  );
  assert.equal(
    service.listEvents().filter((event) => event.event_type === "COMMITMENT_CONFIRMED").length,
    1,
  );
  assert.equal(service.getLotBalance("lot-1").buckets.reserved, 10);
  assert.equal(service.verifyInvariants(), true);
});

test("装卸能力不足时第二个确认无法成交", () => {
  const service = makeService();
  lotReady(service, "lot-1", 100);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 10, occurred_at: T0 });
  const demandA = demandReady(service, { key: "D-A", buyer: "buyer-a", quantity: 10 });
  const demandB = demandReady(service, { key: "D-B", buyer: "buyer-b", quantity: 10 });
  const offerA = service.allocateDemand({ demand_id: demandA.demand_id, occurred_at: T0 }).offers[0];
  const offerB = service.allocateDemand({ demand_id: demandB.demand_id, occurred_at: T0 }).offers[0];
  service.confirmCommitment({ commitment_id: offerA.commitment_id, buyer_id: "buyer-a", agreed_unit_price: 15, occurred_at: T0 });
  assert.throws(
    () => service.confirmCommitment({ commitment_id: offerB.commitment_id, buyer_id: "buyer-b", agreed_unit_price: 15, occurred_at: T0 }),
    (error) => error.code === "INSUFFICIENT_CAPACITY",
  );
});

test("质量封存只重排尚未交收的部分", () => {
  const service = makeService();
  lotReady(service, "lot-a", 100);
  lotReady(service, "lot-b", 100, LATE_WINDOW);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 60 });
  const offer = confirmed(service, demand, 60);
  service.recordDelivery({
    commitment_id: offer.commitment_id,
    delivery_ref: "del-1",
    quantity: 10,
    final_unit_price: 15,
    occurred_at: "2026-10-01T08:00:00+08:00",
  });

  service.quarantineLot({ lot_id: "lot-a", quantity: 80, reason: "抽检农残超标", occurred_at: "2026-10-01T12:00:00+08:00" });

  const balance = service.getLotBalance("lot-a");
  assert.equal(balance.buckets.quarantined, 80);
  assert.equal(balance.buckets.delivered, 10);
  assert.equal(balance.buckets.reserved, 10);
  const victim = service.getCommitment(offer.commitment_id);
  assert.equal(victim.released, 40);
  assert.equal(victim.deliveries.length, 1);

  const replacement = [...service.listEvents()]
    .filter((event) => event.event_type === "COMMITMENT_REPLANNED")
    .map((event) => event.payload.replacements)
    .flat();
  assert.equal(replacement.length, 1);
  const replacementCommitment = service.getCommitment(replacement[0]);
  assert.equal(replacementCommitment.lot_id, "lot-b");
  assert.equal(replacementCommitment.quantity, 40);
  assert.equal(replacementCommitment.replanned_from, offer.commitment_id);
  assert.equal(service.getLotBalance("lot-b").buckets.reserved, 40);
  assert.equal(service.verifyInvariants(), true);
});

test("船期变化只重排交付窗口被突破的未交收承诺", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-a",
    supplier_id: "supplier-1",
    category: "蔬菜",
    grade: "一级",
    quantity: 100,
    arrival_window: WINDOW,
    occurred_at: T0,
  });
  lotReady(service, "lot-b", 50, LATE_WINDOW);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 50, neededBy: "2026-10-02T00:00:00+08:00" });
  const offer = confirmed(service, demand, 50);
  assert.deepEqual(service.getCommitment(offer.commitment_id).sources.in_transit, 50);

  // 新窗口仍在交付期限内：不重排。
  service.updateArrivalWindow({
    lot_id: "lot-a",
    arrival_window: { start: "2026-10-01T08:00:00+08:00", end: "2026-10-01T20:00:00+08:00" },
    reason: "渔船正常返港",
    occurred_at: "2026-09-30T18:00:00+08:00",
  });
  assert.equal(service.listEvents().filter((event) => event.event_type === "COMMITMENT_REPLANNED").length, 0);

  // 新窗口突破交付期限：在途来源的未交收承诺被重排到其他批次。
  service.updateArrivalWindow({
    lot_id: "lot-a",
    arrival_window: { start: "2026-10-05T08:00:00+08:00", end: "2026-10-05T20:00:00+08:00" },
    reason: "台风导致渔船延迟返港",
    occurred_at: "2026-09-30T20:00:00+08:00",
  });
  const balance = service.getLotBalance("lot-a");
  assert.equal(balance.buckets.in_transit, 100);
  assert.equal(balance.buckets.reserved, 0);
  assert.equal(service.getLotBalance("lot-b").buckets.reserved, 50);
  const replanned = service.listEvents().filter((event) => event.event_type === "COMMITMENT_REPLANNED");
  assert.equal(replanned.length, 1);
  assert.equal(replanned[0].payload.cause, "SCHEDULE_CHANGE");
  assert.equal(service.verifyInvariants(), true);
});

test("到货短缺只重排尚未交收的部分", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-a",
    supplier_id: "supplier-1",
    category: "蔬菜",
    grade: "一级",
    quantity: 100,
    arrival_window: WINDOW,
    occurred_at: T0,
  });
  lotReady(service, "lot-b", 100, LATE_WINDOW);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 60 });
  const offer = confirmed(service, demand, 60);

  service.recordArrival({ lot_id: "lot-a", arrived_quantity: 30, final: true, occurred_at: "2026-09-30T09:00:00+08:00" });

  const balance = service.getLotBalance("lot-a");
  assert.equal(balance.buckets.pending_inspection, 30);
  assert.equal(balance.buckets.shortage, 70);
  assert.equal(balance.buckets.reserved, 0);
  const shortage = service.listEvents().find((event) => event.event_type === "LOT_SHORTAGE_RECORDED");
  assert.equal(shortage.payload.quantity, 70);
  const victim = service.getCommitment(offer.commitment_id);
  assert.equal(victim.released, 60);
  assert.equal(victim.state, "released");
  assert.equal(service.getLotBalance("lot-b").buckets.reserved, 60);
  assert.equal(service.verifyInvariants(), true);
});

test("人工改派须说明理由且不能突破数量守恒", () => {
  const service = makeService();
  lotReady(service, "lot-a", 100);
  lotReady(service, "lot-b", 30, LATE_WINDOW);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 50 });
  const offer = confirmed(service, demand, 50);

  assert.throws(
    () => service.reassignCommitment({ commitment_id: offer.commitment_id, to_lot_id: "lot-b", quantity: 10, operator: "op-7", occurred_at: T0 }),
    (error) => error.code === "REASON_REQUIRED",
  );
  assert.throws(
    () => service.reassignCommitment({ commitment_id: offer.commitment_id, to_lot_id: "lot-b", quantity: 40, reason: "A 批次抽检待复核", operator: "op-7", occurred_at: T0 }),
    (error) => error.code === "INSUFFICIENT_BALANCE",
  );
  // 失败的改派不得改变任何余额。
  assert.equal(service.getLotBalance("lot-a").buckets.reserved, 50);

  const { replacement } = service.reassignCommitment({
    commitment_id: offer.commitment_id,
    to_lot_id: "lot-b",
    quantity: 30,
    reason: "A 批次抽检待复核",
    operator: "op-7",
    occurred_at: "2026-10-01T09:00:00+08:00",
  });
  assert.equal(service.getLotBalance("lot-a").buckets.reserved, 20);
  assert.equal(service.getLotBalance("lot-a").buckets.allocatable, 80);
  assert.equal(service.getLotBalance("lot-b").buckets.reserved, 30);
  assert.equal(replacement.reassigned_from, offer.commitment_id);
  const event = service.listEvents().find((item) => item.event_type === "COMMITMENT_REASSIGNED");
  assert.equal(event.payload.reason, "A 批次抽检待复核");
  assert.equal(event.payload.operator, "op-7");
  assert.equal(service.verifyInvariants(), true);
});

test("优先保障规则按冻结版本执行，低优先级承诺先承担封存", () => {
  const service = makeService();
  service.setPriorityRules({ rules: { buyer_priority: ["buyer-vip"], lot_order: "arrival_start_asc" }, occurred_at: T0 });
  lotReady(service, "lot-a", 100);
  lotReady(service, "lot-b", 100, LATE_WINDOW);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });

  const vip = demandReady(service, { key: "D-vip", buyer: "buyer-vip", quantity: 10 });
  const vipOffer = confirmed(service, vip, 10);
  const normal = demandReady(service, { key: "D-normal", buyer: "buyer-normal", quantity: 10 });
  const normalOffer = confirmed(service, normal, 10);
  assert.equal(service.getCommitment(vipOffer.commitment_id).rule_version, 1);

  service.setPriorityRules({ rules: { buyer_priority: ["buyer-vip"], lot_order: "arrival_start_asc" }, occurred_at: T0 });
  const later = demandReady(service, { key: "D-later", buyer: "buyer-normal", quantity: 5 });
  const laterOffer = service.allocateDemand({ demand_id: later.demand_id, occurred_at: T0 }).offers[0];
  assert.equal(laterOffer.rule_version, 2);
  // 已存在的承诺仍记录冻结时的版本。
  assert.equal(service.getCommitment(vipOffer.commitment_id).rule_version, 1);

  service.quarantineLot({ lot_id: "lot-a", quantity: 85, reason: "复检不合格", occurred_at: "2026-10-01T12:00:00+08:00" });
  assert.equal(service.getCommitment(vipOffer.commitment_id).released, 0);
  assert.equal(service.getCommitment(normalOffer.commitment_id).released, 5);
  assert.equal(service.verifyInvariants(), true);
});

test("跨午夜费用、短交赔付与退补价以实际交收版本清算", () => {
  const service = makeService();
  lotReady(service, "lot-1", 100);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });

  const demandA = demandReady(service, { key: "D-A", buyer: "buyer-a", quantity: 10, neededBy: "2026-10-03T12:00:00+08:00" });
  const offerA = confirmed(service, demandA, 10, 15);
  service.recordDelivery({ commitment_id: offerA.commitment_id, delivery_ref: "del-1", quantity: 4, final_unit_price: 15, occurred_at: "2026-10-01T23:30:00+08:00" });
  service.recordDelivery({ commitment_id: offerA.commitment_id, delivery_ref: "del-2", quantity: 6, final_unit_price: 16, occurred_at: "2026-10-02T02:00:00+08:00" });

  const demandB = demandReady(service, { key: "D-B", buyer: "buyer-b", quantity: 8, neededBy: "2026-10-02T00:00:00+08:00" });
  const offerB = confirmed(service, demandB, 8, 12);
  service.recordDelivery({ commitment_id: offerB.commitment_id, delivery_ref: "del-3", quantity: 5, final_unit_price: 12, occurred_at: "2026-10-01T10:00:00+08:00" });

  const result = service.runSettlementBatch({
    period_id: "p-1001",
    as_of: "2026-10-03T06:00:00+08:00",
    fee_config: FEE_CONFIG,
  });
  assert.equal(result.done, true);
  const entries = service.listEntries("p-1001");
  assert.equal(entries.length, 5);

  const goodsA = entries.find((entry) => entry.kind === "goods" && entry.commitment_id === offerA.commitment_id);
  assert.equal(goodsA.amount, 4 * 15 + 6 * 16);
  assert.deepEqual(goodsA.delivery_refs, [
    { delivery_ref: "del-1", version: 1 },
    { delivery_ref: "del-2", version: 2 },
  ]);
  const night = entries.find((entry) => entry.kind === "night_fee");
  assert.equal(night.amount, 6 * 0.5);
  const adjustment = entries.find((entry) => entry.kind === "price_adjustment");
  assert.equal(adjustment.amount, (16 - 15) * 6);
  const short = entries.find((entry) => entry.kind === "short_penalty");
  assert.equal(short.commitment_id, offerB.commitment_id);
  assert.equal(short.amount, 3 * 2);
  assert.equal(short.supplier_id, "supplier-1");
  assert.equal(
    service.listEvents().filter((event) => event.event_type === "SETTLEMENT_POSTED").length,
    5,
  );

  // 已结算的交收不会重复出账。
  const again = service.runSettlementBatch({ period_id: "p-1001", as_of: "2026-10-03T06:00:00+08:00", fee_config: FEE_CONFIG });
  assert.equal(again.processed, 0);
});

test("已出账周期通过冲正调整", () => {
  const service = makeService();
  lotReady(service, "lot-1", 100);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 4 });
  const offer = confirmed(service, demand, 4, 15);
  service.recordDelivery({ commitment_id: offer.commitment_id, delivery_ref: "del-1", quantity: 4, final_unit_price: 15, occurred_at: "2026-10-01T08:00:00+08:00" });
  service.runSettlementBatch({ period_id: "p-1001", as_of: "2026-10-03T06:00:00+08:00", fee_config: FEE_CONFIG });
  const [entry] = service.listEntries("p-1001");
  assert.equal(entry.amount, 60);

  assert.throws(
    () => service.reverseEntry({ entry_id: entry.entry_id, occurred_at: "2026-10-04T08:00:00+08:00" }),
    (error) => error.code === "REASON_REQUIRED",
  );
  const { reversal, original } = service.reverseEntry({
    entry_id: entry.entry_id,
    reason: "交收单价复核后调整",
    occurred_at: "2026-10-04T08:00:00+08:00",
  });
  assert.equal(original.status, "reversed");
  assert.equal(reversal.amount, -60);
  assert.equal(reversal.reverses, entry.entry_id);
  assert.equal(
    service.listEvents().filter((event) => event.event_type === "SETTLEMENT_REVERSED").length,
    1,
  );
  assert.throws(
    () => service.reverseEntry({ entry_id: entry.entry_id, reason: "重复冲正", occurred_at: "2026-10-04T09:00:00+08:00" }),
    (error) => error.code === "INVALID_STATE",
  );
  assert.throws(
    () => service.reverseEntry({ entry_id: reversal.entry_id, reason: "冲正冲正", occurred_at: "2026-10-04T09:00:00+08:00" }),
    (error) => error.code === "INVALID_STATE",
  );
});

test("财务批处理中断后继续未完成账项", () => {
  const service = makeService();
  lotReady(service, "lot-1", 100);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  for (const [index, key] of ["D-1", "D-2", "D-3"].entries()) {
    const demand = demandReady(service, { key, quantity: 5 });
    const offer = confirmed(service, demand, 5, 15);
    service.recordDelivery({
      commitment_id: offer.commitment_id,
      delivery_ref: `del-${index + 1}`,
      quantity: 5,
      final_unit_price: 15,
      occurred_at: "2026-10-01T08:00:00+08:00",
    });
  }

  const first = service.runSettlementBatch({ period_id: "p-1001", as_of: "2026-10-03T06:00:00+08:00", fee_config: FEE_CONFIG, limit: 2 });
  assert.equal(first.processed, 2);
  assert.equal(first.done, false);
  assert.equal(first.remaining, 1);

  const second = service.runSettlementBatch({ period_id: "p-1001", as_of: "2026-10-03T06:00:00+08:00", fee_config: FEE_CONFIG });
  assert.equal(second.processed, 1);
  assert.equal(second.done, true);

  const entries = service.listEntries("p-1001");
  assert.equal(entries.length, 3);
  assert.equal(new Set(entries.map((entry) => entry.entry_id)).size, 3);
  const third = service.runSettlementBatch({ period_id: "p-1001", as_of: "2026-10-03T06:00:00+08:00", fee_config: FEE_CONFIG });
  assert.equal(third.processed, 0);
});

test("运营可以从 API 看见缺口为何形成", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-1",
    supplier_id: "supplier-1",
    category: "蔬菜",
    grade: "一级",
    quantity: 100,
    locked_external: 30,
    arrival_window: WINDOW,
    occurred_at: T0,
  });
  service.recordArrival({ lot_id: "lot-1", arrived_quantity: 50, final: true, occurred_at: "2026-09-30T09:00:00+08:00" });
  service.recordInspection({ lot_id: "lot-1", passed_quantity: 40, quarantined_quantity: 10, occurred_at: "2026-09-30T10:00:00+08:00" });
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 100 });
  const { unallocated } = service.allocateDemand({ demand_id: demand.demand_id, occurred_at: T0 });
  assert.equal(unallocated, 60);

  const explanation = service.explainGap(demand.demand_id);
  assert.equal(explanation.required, 100);
  assert.equal(explanation.offered, 40);
  assert.equal(explanation.gap, 100);
  assert.equal(explanation.lots[0].buckets.locked_external, 30);
  assert.equal(explanation.lots[0].buckets.shortage, 20);
  assert.equal(explanation.lots[0].buckets.quarantined, 10);
  const notes = explanation.notes.join("\n");
  assert.match(notes, /被其他市场锁定 30/);
  assert.match(notes, /到货短缺 20/);
  assert.match(notes, /质量封存 10/);
  assert.match(notes, /缺口 100/);
});

test("任意一笔付款都能追到货源、检验、占用和交收事实", () => {
  const service = makeService();
  lotReady(service, "lot-1", 100);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 10 });
  const offer = confirmed(service, demand, 10, 15);
  service.recordDelivery({ commitment_id: offer.commitment_id, delivery_ref: "del-1", quantity: 10, final_unit_price: 15, occurred_at: "2026-10-01T08:00:00+08:00" });
  service.runSettlementBatch({ period_id: "p-1001", as_of: "2026-10-03T06:00:00+08:00", fee_config: FEE_CONFIG });
  const [entry] = service.listEntries("p-1001");

  const trace = service.tracePayment(entry.entry_id);
  assert.equal(trace.lot.lot_id, "lot-1");
  assert.equal(trace.lot.supplier_id, "supplier-1");
  assert.equal(trace.commitment.commitment_id, offer.commitment_id);
  assert.equal(trace.demand.business_key, "D-1");
  assert.ok(trace.inspections.some((event) => event.event_type === "LOT_INSPECTED"));
  assert.deepEqual(
    trace.reservations.map((event) => event.event_type),
    ["CAPACITY_RESERVED", "COMMITMENT_CONFIRMED"],
  );
  assert.deepEqual(
    trace.deliveries.map((delivery) => [delivery.delivery_ref, delivery.version]),
    [["del-1", 1]],
  );
});

test("交收回执按单号幂等，异内容报错", () => {
  const service = makeService();
  lotReady(service, "lot-1", 100);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 10 });
  const offer = confirmed(service, demand, 10, 15);

  const first = service.recordDelivery({ commitment_id: offer.commitment_id, delivery_ref: "del-1", quantity: 4, final_unit_price: 15, occurred_at: "2026-10-01T08:00:00+08:00" });
  assert.equal(first.status, "accepted");
  const retry = service.recordDelivery({ commitment_id: offer.commitment_id, delivery_ref: "del-1", quantity: 4, final_unit_price: 15, occurred_at: "2026-10-01T08:00:00+08:00" });
  assert.equal(retry.status, "idempotent");
  assert.equal(service.getCommitment(offer.commitment_id).deliveries.length, 1);
  assert.equal(service.getLotBalance("lot-1").buckets.delivered, 4);
  assert.throws(
    () => service.recordDelivery({ commitment_id: offer.commitment_id, delivery_ref: "del-1", quantity: 5, final_unit_price: 15, occurred_at: "2026-10-01T08:00:00+08:00" }),
    (error) => error.code === "DELIVERY_CONFLICT",
  );
  assert.equal(
    service.listEvents().filter((event) => event.event_type === "DELIVERY_ACCEPTED").length,
    1,
  );
});

test("封存后未成交报价作废，全部事件通过契约校验且版本递增", () => {
  const service = makeService();
  lotReady(service, "lot-1", 100);
  service.declareHandlingCapacity({ window_id: "w-1001", capacity: 500, occurred_at: T0 });
  const demand = demandReady(service, { key: "D-1", quantity: 10 });
  const [offer] = service.allocateDemand({ demand_id: demand.demand_id, occurred_at: T0 }).offers;

  service.quarantineLot({ lot_id: "lot-1", quantity: 5, reason: "抽检不合格", occurred_at: "2026-10-01T12:00:00+08:00" });
  assert.equal(service.getCommitment(offer.commitment_id).state, "stale");
  assert.throws(
    () => service.confirmCommitment({ commitment_id: offer.commitment_id, buyer_id: "buyer-1", agreed_unit_price: 15, occurred_at: T0 }),
    (error) => error.code === "INVALID_STATE",
  );

  const events = service.listEvents();
  for (const event of events) {
    assert.deepEqual(validateEvent(event, schema), [], `事件 ${event.event_id} 应通过契约校验`);
  }
  const lotEvents = events.filter((event) => event.aggregate_id === "lot-1");
  assert.deepEqual(
    lotEvents.map((event) => event.version),
    lotEvents.map((_, index) => index + 1),
  );
});
