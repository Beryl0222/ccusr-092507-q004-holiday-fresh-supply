import assert from "node:assert/strict";
import test from "node:test";

import { ClearingService, DomainRejected } from "../src/domain/clearing.js";
import { ConcurrencyConflict } from "../src/domain/store.js";
import { projectLot } from "../src/domain/quantities.js";

let counter = 0;
function makeService(options = {}) {
  counter = 0;
  let clock = options.start ?? "2026-09-24T12:00:00+08:00";
  const service = new ClearingService(undefined, {
    now: () => clock,
    idGen: (type) => `${type}-${(++counter).toString(3)}`,
    overnightRate: options.overnightRate ?? 0.5,
    shortfallRate: options.shortfallRate ?? 2,
  });
  service.advance = (iso) => {
    clock = iso;
  };
  return service;
}

const WINDOW = { id: "win-0925-am", start: "2026-09-25T03:00:00+08:00", end: "2026-09-25T06:00:00+08:00" };

function declareReadyLot(service, lotId, quantity, overrides = {}) {
  service.declareLot({
    lot_id: lotId,
    supplier_id: "supplier-1",
    category: "vegetable",
    grade: "A",
    unit: "kg",
    quantity,
    arrival_window: WINDOW,
    price_range: { min: 4, max: 5, currency: "CNY" },
    ...overrides,
  });
  service.lotArrived(lotId, quantity);
  service.inspect(lotId, { inspection_id: `insp-${lotId}`, result: "passed" });
  return lotId;
}

function registerDemand(service, businessNo, quantity, maxPrice = 6) {
  return service.registerDemand({
    business_no: businessNo,
    category: "vegetable",
    grade: "A",
    unit: "kg",
    quantity,
    window: WINDOW,
    max_price: maxPrice,
  });
}

function proposeConfirm(service, { businessNo, commitmentId, lotId, quantity, price = 4.5, freeze = "v1" }) {
  service.proposeCommitment({ business_no: businessNo, commitment_id: commitmentId, lot_id: lotId, quantity, price });
  return service.confirmAllocation({ commitment_id: commitmentId, freeze_version: freeze });
}

test("供应商口中的已备货被拆成可解释桶位：在途/待检/锁定/封存都不是硬额度", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-1", supplier_id: "s1", category: "vegetable", grade: "A", unit: "kg",
    quantity: 1000, arrival_window: WINDOW, price_range: { min: 4, max: 5, currency: "CNY" },
  });
  let lot = service.snapshot().lots.get("lot-1");
  assert.equal(lot.atp.hard, 0);
  assert.equal(lot.atp.soft_in_transit, 1000);

  service.lotArrived("lot-1", 1000);
  lot = service.snapshot().lots.get("lot-1");
  assert.equal(lot.atp.soft_pending, 1000);

  service.inspect("lot-1", { inspection_id: "insp-1", result: "passed" });
  service.externalLock("lot-1", { quantity: 300, market_ref: "market-b-07" });
  service.quarantine("lot-1", { hold_id: "hold-1", quantity: 200, reason: "农残抽检复核" });
  lot = service.snapshot().lots.get("lot-1");
  assert.equal(lot.atp.hard, 500);
  assert.equal(lot.conservation_ok, true);
  assert.deepEqual(
    lot.atp_lines.filter((line) => line.quantity > 0).map((line) => `${line.code}:${line.quantity}`),
    ["AVAILABLE:500", "QUARANTINE_HOLD:200", "EXTERNAL_LOCK:300"],
  );
});

test("批次全生命周期数量守恒（1000 斤分拆到全部终态）", () => {
  const service = makeService();
  declareReadyLot(service, "lot-x", 1000);
  registerDemand(service, "bn-1", 600);
  proposeConfirm(service, { businessNo: "bn-1", commitmentId: "c-1", lotId: "lot-x", quantity: 600 });
  // 占用后：600 allocated，400 available
  service.externalLock("lot-x", { quantity: 100, market_ref: "m1" });
  service.quarantine("lot-x", { hold_id: "h1", quantity: 50, reason: "抽检" });
  service.recordLoss("lot-x", { quantity: 30, stage: "available", reason: "失水" });
  service.advance("2026-09-25T04:00:00+08:00");
  service.acceptDelivery({ delivery_id: "d-1", commitment_id: "c-1", quantity: 580 });
  const lot = service.snapshot().lots.get("lot-x");
  assert.equal(lot.conservation_ok, true);
  assert.equal(lot.declared, 1000);
  assert.equal(lot.buckets.delivered, 580);
  assert.equal(lot.buckets.allocated, 20);
  assert.equal(lot.buckets.external_locked, 100);
  assert.equal(lot.buckets.quarantined, 50);
  assert.equal(lot.buckets.lost, 30);
  assert.equal(lot.buckets.available, 220);
});

test("采购需求重试幂等；同一业务号异内容进入争议", () => {
  const service = makeService();
  const base = { business_no: "bn-9", category: "vegetable", grade: "A", unit: "kg", quantity: 100, window: WINDOW, max_price: 6 };
  const first = service.registerDemand(base);
  const replay = service.registerDemand(base);
  assert.equal(first.status, "accepted");
  assert.equal(replay.status, "replayed");

  assert.throws(
    () => service.registerDemand({ ...base, quantity: 120 }),
    (error) => error.code === "IDEMPOTENCY_CONTENT_MISMATCH",
  );
  const dispute = service.snapshot().disputes[0];
  assert.equal(dispute.kind, "IDEMPOTENCY_CONTENT_MISMATCH");
  assert.ok(dispute.fingerprint_existing);
  assert.notEqual(dispute.fingerprint_existing, dispute.fingerprint_incoming);

  // 争议可被人工处理，处理动作幂等
  const resolved = service.resolveDispute({ dispute_id: dispute.dispute_id, resolution: { action: "REJECT_LATEST" }, operator_id: "op-1" });
  assert.equal(resolved.status, "resolved");
  assert.equal(service.snapshot().disputes[0].status, "resolved");
  assert.equal(
    service.resolveDispute({ dispute_id: dispute.dispute_id, resolution: { action: "REJECT_LATEST" }, operator_id: "op-1" }).status,
    "replayed",
  );
});

test("供应商补传回执幂等，回执内容不一致进入争议", () => {
  const service = makeService();
  declareReadyLot(service, "lot-a", 100);
  registerDemand(service, "bn-a", 50);
  service.proposeCommitment({ business_no: "bn-a", commitment_id: "c-a", lot_id: "lot-a", quantity: 50, price: 4.5 });
  const ack = { business_no: "bn-a", commitment_id: "c-a", ack: { code: "ACCEPTED", at: "2026-09-24T13:00:00+08:00" } };
  assert.equal(service.ackCommitment(ack).status, "accepted");
  assert.equal(service.ackCommitment(ack).status, "replayed");
  assert.throws(
    () => service.ackCommitment({ ...ack, ack: { code: "REJECTED", at: "2026-09-24T13:05:00+08:00" } }),
    (error) => error.code === "IDEMPOTENCY_CONTENT_MISMATCH",
  );
});

test("两个采购方并发确认最后一份额度：只有一个成交", async () => {
  const service = makeService();
  // 供应商在途报了 200，两家各获得 100 的软承诺；渔船实际只到 100。
  service.declareLot({
    lot_id: "lot-last", supplier_id: "s1", category: "vegetable", grade: "A", unit: "kg",
    quantity: 200, arrival_window: WINDOW, price_range: { min: 4, max: 5, currency: "CNY" },
  });
  registerDemand(service, "bn-p1", 100);
  registerDemand(service, "bn-p2", 100);
  service.proposeCommitment({ business_no: "bn-p1", commitment_id: "c-p1", lot_id: "lot-last", quantity: 100, price: 4.5 });
  service.proposeCommitment({ business_no: "bn-p2", commitment_id: "c-p2", lot_id: "lot-last", quantity: 100, price: 4.5 });
  service.lotArrived("lot-last", 100);
  service.recordShortage("lot-last", { quantity: 100, reason: "渔船返港量不足" });
  service.inspect("lot-last", { inspection_id: "insp-last", result: "passed" });

  const results = await Promise.allSettled([
    service.withLotLock("lot-last", async () => service.confirmAllocation({ commitment_id: "c-p1" })),
    service.withLotLock("lot-last", async () => service.confirmAllocation({ commitment_id: "c-p2" })),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "ATP_INSUFFICIENT");
  const lot = service.snapshot().lots.get("lot-last");
  assert.equal(lot.buckets.allocated, 100);
  assert.equal(lot.buckets.available, 0);
  assert.equal(lot.conservation_ok, true);
});

test("乐观锁版本号拦截过期确认（VERSION_CONFLICT）", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-v", supplier_id: "s1", category: "vegetable", grade: "A", unit: "kg",
    quantity: 200, arrival_window: WINDOW, price_range: { min: 4, max: 5, currency: "CNY" },
  });
  registerDemand(service, "bn-v1", 60);
  registerDemand(service, "bn-v2", 60);
  service.proposeCommitment({ business_no: "bn-v1", commitment_id: "c-v1", lot_id: "lot-v", quantity: 60, price: 4.5 });
  service.proposeCommitment({ business_no: "bn-v2", commitment_id: "c-v2", lot_id: "lot-v", quantity: 60, price: 4.5 });
  service.lotArrived("lot-v", 100);
  service.recordShortage("lot-v", { quantity: 100, reason: "在途短缺" });
  service.inspect("lot-v", { inspection_id: "insp-v", result: "passed" });
  const versionAtRead = service.store.read("lot-v").length;
  service.confirmAllocation({ commitment_id: "c-v1" });
  assert.throws(
    () => service.confirmAllocation({ commitment_id: "c-v2", expected_version: versionAtRead }),
    (error) => error instanceof ConcurrencyConflict,
  );
});

test("质量封存只重排未交收部分，且严格按冻结优先级：低优先级被挤出，高优先级保留", () => {
  const service = makeService();
  declareReadyLot(service, "lot-main", 200);
  declareReadyLot(service, "lot-backup", 100, { price_range: { min: 4, max: 5, currency: "CNY" } });
  registerDemand(service, "bn-hi", 100);
  registerDemand(service, "bn-lo", 100);
  const demands = service.snapshot().demands;
  const hiId = demands.get("bn-hi").demand_id;
  const loId = demands.get("bn-lo").demand_id;
  proposeConfirm(service, { businessNo: "bn-hi", commitmentId: "c-hi", lotId: "lot-main", quantity: 100 });
  proposeConfirm(service, { businessNo: "bn-lo", commitmentId: "c-lo", lotId: "lot-main", quantity: 100 });

  service.freezePriority({
    round_id: "round-1",
    freeze_version: "v1",
    criteria: ["战略保供", "下单时间"],
    ranking: [{ demand_id: hiId, priority: 1 }, { demand_id: loId, priority: 2 }],
  });

  // 高优先级先交收 60，封存 80：受损的是 40（高优先级未交收）+ 40（低优先级）
  service.advance("2026-09-25T03:30:00+08:00");
  service.acceptDelivery({ delivery_id: "d-hi", commitment_id: "c-hi", quantity: 60 });
  service.quarantine("lot-main", { hold_id: "hold-q", quantity: 80, reason: "农残超标待复核" });

  const result = service.rearrange({ round_id: "round-1", lot_ids: ["lot-main"], trigger: "QUALITY_HOLD" });
  assert.equal(result.status, "rearranged");
  // 封存 80 从未交收占用 140（高40+低100）中抽走；按冻结优先级，高优先级 40 全部保住，
  // 低优先级被挤出 80，全部由备份批次补位。
  const moved = result.items.filter((item) => item.action === "moved");
  assert.equal(moved.length, 1);
  assert.equal(moved[0].commitment_id, "c-lo");
  assert.equal(moved[0].to_lot_id, "lot-backup");
  assert.equal(moved[0].quantity, 80);

  const view = service.snapshot();
  assert.equal(view.lots.get("lot-main").buckets.allocated, 60);
  assert.equal(view.lots.get("lot-main").buckets.delivered, 60);
  assert.equal(view.lots.get("lot-backup").buckets.allocated, 80);
});

test("替代批次不足时低优先级缺口被短关，高优先级不受影响", () => {
  const service = makeService();
  declareReadyLot(service, "lot-m2", 100);
  declareReadyLot(service, "lot-b2", 30);
  registerDemand(service, "bn-h2", 60);
  registerDemand(service, "bn-l2", 40);
  const demands = service.snapshot().demands;
  proposeConfirm(service, { businessNo: "bn-h2", commitmentId: "c-h2", lotId: "lot-m2", quantity: 60 });
  proposeConfirm(service, { businessNo: "bn-l2", commitmentId: "c-l2", lotId: "lot-m2", quantity: 40 });
  service.freezePriority({
    round_id: "round-2", freeze_version: "v1", criteria: ["保供"],
    ranking: [{ demand_id: demands.get("bn-h2").demand_id, priority: 1 }, { demand_id: demands.get("bn-l2").demand_id, priority: 2 }],
  });
  service.recordLoss("lot-m2", { quantity: 70, stage: "allocated", reason: "冷藏故障" });
  const result = service.rearrange({ round_id: "round-2", lot_ids: ["lot-m2"], trigger: "LOSS" });
  // 剩余 30 占用按优先级全部判给高优先级：高损失 30（备份补齐），低优先级 40 全部短关。
  const byCommitment = new Map();
  for (const item of result.items) {
    const list = byCommitment.get(item.commitment_id) ?? [];
    list.push(item);
    byCommitment.set(item.commitment_id, list);
  }
  const hiItems = byCommitment.get("c-h2");
  assert.deepEqual(hiItems.map((item) => [item.action, item.quantity]), [["moved", 30]]);
  const loItems = byCommitment.get("c-l2");
  assert.deepEqual(loItems.map((item) => [item.action, item.quantity]), [["short_closed", 40]]);
});

test("到货短缺（在途未到）只重排受影响承诺，已交收不动", () => {
  const service = makeService();
  service.declareLot({
    lot_id: "lot-ship", supplier_id: "s-fish", category: "seafood", grade: "A", unit: "kg",
    quantity: 500, arrival_window: WINDOW, price_range: { min: 20, max: 24, currency: "CNY" },
  });
  service.declareLot({
    lot_id: "lot-ship2", supplier_id: "s-fish2", category: "seafood", grade: "A", unit: "kg",
    quantity: 500, arrival_window: WINDOW, price_range: { min: 21, max: 23, currency: "CNY" },
  });
  service.lotArrived("lot-ship2", 500);
  service.inspect("lot-ship2", { inspection_id: "i2", result: "passed" });
  service.registerDemand({ business_no: "bn-fish", category: "seafood", grade: "A", unit: "kg", quantity: 500, window: WINDOW, max_price: 25 });
  service.proposeCommitment({ business_no: "bn-fish", commitment_id: "c-fish", lot_id: "lot-ship", quantity: 500, price: 22 });
  // 在途承诺不能直接确认：需要等到货检验
  assert.throws(
    () => service.confirmAllocation({ commitment_id: "c-fish" }),
    (error) => error.code === "ATP_INSUFFICIENT",
  );
  // 船期变化：只到 300，200 短缺
  service.updateSchedule("lot-ship", { vessel_trip_id: "vessel-77", arrival_window: WINDOW, reason: "大风延后6小时" });
  service.lotArrived("lot-ship", 300);
  service.recordShortage("lot-ship", { quantity: 200, reason: "渔船返港量不足" });
  service.inspect("lot-ship", { inspection_id: "i1", result: "passed" });
  // 只到货 300：先部分确认 300
  service.confirmAllocation({ commitment_id: "c-fish", quantity: 300 });
  // 触发重排：未确认的 200 承诺从 lot-ship2 补齐
  service.freezePriority({ round_id: "r-fish", freeze_version: "v1", criteria: ["保供"], ranking: [{ demand_id: service.snapshot().demands.get("bn-fish").demand_id, priority: 1 }] });
  const result = service.rearrange({ round_id: "r-fish", lot_ids: ["lot-ship"], trigger: "SHORTAGE" });
  const move = result.items.find((item) => item.action === "moved");
  assert.equal(move.quantity, 200);
  assert.equal(move.to_lot_id, "lot-ship2");
  assert.equal(move.stage, "promise");
  // 两份占用各自守恒
  const view = service.snapshot();
  assert.equal(view.lots.get("lot-ship").buckets.allocated, 300);
  assert.equal(view.lots.get("lot-ship2").buckets.allocated, 200);

  // 两批货在各自窗口实际交收并分别清算，付款可同时追到两个货源批次
  const childId = move.split_commitment_id;
  service.acceptDelivery({ delivery_id: "d-fish-1", commitment_id: "c-fish", quantity: 300, accepted_at: "2026-09-25T05:00:00+08:00" });
  service.acceptDelivery({ delivery_id: "d-fish-2", commitment_id: childId, quantity: 200, accepted_at: "2026-09-25T08:00:00+08:00" });
  service.postSettlement({ period_id: "p-fish", delivery_id: "d-fish-1" });
  service.postSettlement({ period_id: "p-fish", delivery_id: "d-fish-2" });
  const payment = service.issuePayment({ payment_id: "pay-fish", settlement_entry_ids: ["entry-d-fish-1", "entry-d-fish-2"] });
  assert.equal(payment.amount, 500 * 22);
  const lotIds = service.tracePayment("pay-fish").trace.map((fact) => fact.lot.lot_id).sort();
  assert.deepEqual(lotIds, ["lot-ship", "lot-ship2"]);
});

test("人工改派必须填写理由、同品类同等级且不突破数量守恒", () => {
  const service = makeService();
  declareReadyLot(service, "lot-r", 100);
  registerDemand(service, "bn-from", 100);
  registerDemand(service, "bn-to", 100);
  proposeConfirm(service, { businessNo: "bn-from", commitmentId: "c-from", lotId: "lot-r", quantity: 100 });

  assert.throws(
    () => service.reassign({ commitment_id: "c-from", to_business_no: "bn-to", new_commitment_id: "c-to", quantity: 100, reason: "  ", operator_id: "op-1" }),
    (error) => error.code === "REASON_REQUIRED",
  );
  const before = service.snapshot().lots.get("lot-r");
  service.reassign({ commitment_id: "c-from", to_business_no: "bn-to", new_commitment_id: "c-to", quantity: 100, reason: "原采购方档口临时关闭，转保供食堂", operator_id: "op-1" });
  const after = service.snapshot().lots.get("lot-r");
  assert.equal(after.buckets.allocated, before.buckets.allocated);
  assert.equal(after.conservation_ok, true);
  // 不能超改：已无未交收量
  assert.throws(
    () => service.reassign({ commitment_id: "c-from", to_business_no: "bn-to", new_commitment_id: "c-to2", quantity: 1, reason: "再次改派", operator_id: "op-1" }),
    (error) => error.code === "QUANTITY_CONSERVATION",
  );
});

test("交收清算：短交赔付、跨午夜费用、退补价都以实际交收版本计算", () => {
  const service = makeService();
  declareReadyLot(service, "lot-s", 100);
  registerDemand(service, "bn-s", 100);
  proposeConfirm(service, { businessNo: "bn-s", commitmentId: "c-s", lotId: "lot-s", quantity: 100 });
  // 实际次日凌晨交收 90（跨午夜），结算价 4.2（承诺 4.5）
  service.advance("2026-09-26T00:30:00+08:00");
  service.acceptDelivery({ delivery_id: "d-s", commitment_id: "c-s", quantity: 90, accepted_at: "2026-09-26T00:30:00+08:00" });
  const result = service.postSettlement({ period_id: "p-20260925", delivery_id: "d-s", final_price: 4.2, overnight_rate: 0.5, shortfall_rate: 2 });
  const byType = Object.fromEntries(result.settlement.lines.map((line) => [line.type, line.amount]));
  // 货款 90*4.5=405；退补 90*(4.2-4.5)=-27；跨午夜 90*0.5=45；短赔 10*2=-20
  assert.equal(byType.BASE, 405);
  assert.equal(byType.PRICE_ADJUST, -27);
  assert.equal(byType.OVERNIGHT_HANDLING, 45);
  assert.equal(byType.SHORTFALL_COMPENSATION, -20);
  assert.equal(result.settlement.amount, 403);
});

test("已出账周期不能改账，只能冲正", () => {
  const service = makeService();
  declareReadyLot(service, "lot-p", 10);
  registerDemand(service, "bn-p", 10);
  proposeConfirm(service, { businessNo: "bn-p", commitmentId: "c-p", lotId: "lot-p", quantity: 10 });
  service.acceptDelivery({ delivery_id: "d-p", commitment_id: "c-p", quantity: 10, accepted_at: "2026-09-25T05:00:00+08:00" });
  service.postSettlement({ period_id: "p1", delivery_id: "d-p" });
  service.closePeriod("p1");
  assert.throws(
    () => service.postSettlement({ period_id: "p1", delivery_id: "d-p" }),
    (error) => error.code === "PERIOD_CLOSED",
  );
  const reversal = service.reverseSettlement({ original_entry_id: "entry-d-p", reason: "检验等级复核改按 B 级价" });
  assert.equal(reversal.event.payload.amount, -45);
  // 冲正幂等
  const again = service.reverseSettlement({ original_entry_id: "entry-d-p", reason: "检验等级复核改按 B 级价" });
  assert.equal(again.status, "replayed");
});

test("财务批处理中断后继续，只补未完成账项", async () => {
  const service = makeService();
  for (let i = 1; i <= 3; i++) {
    declareReadyLot(service, `lot-b${i}`, 10);
    registerDemand(service, `bn-b${i}`, 10);
    proposeConfirm(service, { businessNo: `bn-b${i}`, commitmentId: `c-b${i}`, lotId: `lot-b${i}`, quantity: 10 });
    service.acceptDelivery({ delivery_id: `d-b${i}`, commitment_id: `c-b${i}`, quantity: 10, accepted_at: "2026-09-25T05:00:00+08:00" });
  }
  const batch = { period_id: "p-batch", items: [{ delivery_id: "d-b1" }, { delivery_id: "d-b2" }, { delivery_id: "d-b3" }] };
  const first = await service.runSettlementBatch(batch, { failAfter: 2 });
  assert.equal(first.status, "interrupted");
  assert.equal(first.posted.length, 2);
  assert.deepEqual(first.remaining.map((item) => item.delivery_id), ["d-b3"]);
  // 重跑整批：前两笔重放，第三笔补账
  const second = await service.runSettlementBatch(batch);
  assert.equal(second.status, "completed");
  assert.deepEqual(second.posted.map((item) => item.status), ["replayed", "replayed", "posted"]);
});

test("任意一笔付款都能追到货源、检验、占用与交收事实", () => {
  const service = makeService();
  declareReadyLot(service, "lot-t", 100);
  registerDemand(service, "bn-t", 100);
  proposeConfirm(service, { businessNo: "bn-t", commitmentId: "c-t", lotId: "lot-t", quantity: 100 });
  service.acceptDelivery({ delivery_id: "d-t", commitment_id: "c-t", quantity: 100, accepted_at: "2026-09-25T04:00:00+08:00" });
  service.postSettlement({ period_id: "p-t", delivery_id: "d-t" });
  const payment = service.issuePayment({ payment_id: "pay-1", settlement_entry_ids: ["entry-d-t"] });
  assert.equal(payment.amount, 450);
  const trace = service.tracePayment("pay-1");
  const fact = trace.trace[0];
  assert.equal(fact.lot.lot_id, "lot-t");
  assert.equal(fact.lot.supplier_id, "supplier-1");
  assert.deepEqual(fact.lot.inspections, [{ inspection_id: "insp-lot-t", result: "passed" }]);
  assert.equal(fact.delivery.delivery_id, "d-t");
  assert.equal(fact.commitment.business_no, "bn-t");
  assert.equal(fact.commitment.freeze_version, "v1");
  // 付款幂等
  assert.equal(service.issuePayment({ payment_id: "pay-1", settlement_entry_ids: ["entry-d-t"] }).status, "replayed");
});

test("运营可从 API 看见缺口为何形成", () => {
  const service = makeService();
  declareReadyLot(service, "lot-g", 100);
  service.quarantine("lot-g", { hold_id: "hg", quantity: 40, reason: "农残复核" });
  registerDemand(service, "bn-g", 100);
  service.proposeCommitment({ business_no: "bn-g", commitment_id: "c-g", lot_id: "lot-g", quantity: 60, price: 4.5 });
  service.confirmAllocation({ commitment_id: "c-g" });
  service.acceptDelivery({ delivery_id: "d-g", commitment_id: "c-g", quantity: 50, accepted_at: "2026-09-25T05:00:00+08:00" });
  const gap = service.explainGap("bn-g");
  assert.equal(gap.demand_quantity, 100);
  assert.equal(gap.delivered, 50);
  assert.equal(gap.gap, 50);
  const causes = gap.chain[0].causes.map((cause) => cause.code);
  assert.ok(causes.includes("QUARANTINE_HOLD"));
  assert.ok(gap.chain[0].history.some((item) => item.event === "ALLOCATION_CONFIRMED"));
});

test("承诺价超出批次价格区间被拒绝", () => {
  const service = makeService();
  declareReadyLot(service, "lot-price", 10);
  registerDemand(service, "bn-price", 10);
  assert.throws(
    () => service.proposeCommitment({ business_no: "bn-price", commitment_id: "c-price", lot_id: "lot-price", quantity: 10, price: 9 }),
    (error) => error.code === "PRICE_OUT_OF_RANGE",
  );
});

test("实交量不能超过未交收占用量", () => {
  const service = makeService();
  declareReadyLot(service, "lot-o", 10);
  registerDemand(service, "bn-o", 10);
  proposeConfirm(service, { businessNo: "bn-o", commitmentId: "c-o", lotId: "lot-o", quantity: 10 });
  assert.throws(
    () => service.acceptDelivery({ delivery_id: "d-o1", commitment_id: "c-o", quantity: 11, accepted_at: "2026-09-25T05:00:00+08:00" }),
    (error) => error.code === "OVER_DELIVERY",
  );
  service.acceptDelivery({ delivery_id: "d-o1", commitment_id: "c-o", quantity: 10, accepted_at: "2026-09-25T05:00:00+08:00" });
  // 交收单重放
  assert.equal(
    service.acceptDelivery({ delivery_id: "d-o1", commitment_id: "c-o", quantity: 10, accepted_at: "2026-09-25T05:00:00+08:00" }).status,
    "replayed",
  );
});

test("账本投影对非法输入（负数量/桶位透支）直接报错", () => {
  assert.throws(() => projectLot([
    { event_type: "LOT_DECLARED", payload: { quantity: 5 } },
    { event_type: "LOT_ARRIVED", payload: { quantity: 6 } },
  ], "lot"));
});
