import assert from "node:assert/strict";
import test from "node:test";

import { ClearingService } from "../src/domain/clearing.js";
import { startApi } from "../src/api.js";

const WINDOW = { id: "win-1", start: "2026-09-25T03:00:00+08:00", end: "2026-09-25T06:00:00+08:00" };

async function jsonFetch(base, path, options) {
  const response = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  return { status: response.status, body: await response.json() };
}

test("运营可经 HTTP API 查看批次额度、缺口解释与付款追溯", async () => {
  let clock = "2026-09-24T12:00:00+08:00";
  const service = new ClearingService(undefined, { now: () => clock });
  const api = await startApi(service);
  const base = `http://127.0.0.1:${api.port}`;
  try {
    // 批次台账
    service.declareLot({
      lot_id: "lot-http", supplier_id: "s1", category: "vegetable", grade: "A", unit: "kg",
      quantity: 100, arrival_window: WINDOW, price_range: { min: 4, max: 5, currency: "CNY" },
    });
    const lotView = await jsonFetch(base, "/lots/lot-http");
    assert.equal(lotView.status, 200);
    assert.equal(lotView.body.atp.soft_in_transit, 100);
    assert.equal(lotView.body.conservation_ok, true);

    // 走完整条链路
    service.lotArrived("lot-http", 100);
    service.inspect("lot-http", { inspection_id: "insp-1", result: "passed" });
    service.registerDemand({ business_no: "bn-http", category: "vegetable", grade: "A", unit: "kg", quantity: 100, window: WINDOW, max_price: 6 });
    service.proposeCommitment({ business_no: "bn-http", commitment_id: "c-http", lot_id: "lot-http", quantity: 100, price: 4.5 });
    service.confirmAllocation({ commitment_id: "c-http" });
    clock = "2026-09-25T04:00:00+08:00";
    service.acceptDelivery({ delivery_id: "d-http", commitment_id: "c-http", quantity: 90 });
    service.postSettlement({ period_id: "p1", delivery_id: "d-http", shortfall_rate: 2 });
    service.issuePayment({ payment_id: "pay-http", settlement_entry_ids: ["entry-d-http"] });

    const gap = await jsonFetch(base, "/gaps/bn-http");
    assert.equal(gap.status, 200);
    assert.equal(gap.body.gap, 10);
    assert.equal(gap.body.delivered, 90);

    const trace = await jsonFetch(base, "/payments/pay-http/trace");
    assert.equal(trace.status, 200);
    assert.equal(trace.body.trace[0].lot.lot_id, "lot-http");
    assert.equal(trace.body.trace[0].delivery.delivery_id, "d-http");

    // 同业务号异内容：409 争议
    const conflict = await jsonFetch(base, "/commands/register_demand", {
      method: "POST",
      body: JSON.stringify({ business_no: "bn-http", category: "vegetable", grade: "A", unit: "kg", quantity: 120, window: WINDOW, max_price: 6 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_CONTENT_MISMATCH");

    const health = await jsonFetch(base, "/health");
    assert.equal(health.body.status, "ok");
  } finally {
    api.close();
  }
});
