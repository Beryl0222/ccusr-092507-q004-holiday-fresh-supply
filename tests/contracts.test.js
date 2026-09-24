import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/contracts.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));

test("中文样例通过校验", () => {
  assert.deepEqual(validateEvent(sample, schema), []);
});

test("缺少信封字段时按稳定顺序报告", () => {
  const issues = validateEvent({}, schema);
  assert.deepEqual(issues.map((item) => item.field), issues.map((item) => item.field).toSorted());
  assert.ok(issues.some((item) => item.field === "event_id"));
});

test("时间必须带时区且版本必须为正整数", () => {
  const issues = validateEvent({ ...sample, occurred_at: "2026-09-24T12:00:00", version: 0 }, schema);
  assert.ok(issues.some((item) => item.field === "occurred_at" && item.code === "timezone_required"));
  assert.ok(issues.some((item) => item.field === "version" && item.code === "positive_integer"));
});

test("事件专属载荷不可缺失", () => {
  const issues = validateEvent({ ...sample, event_type: "LOT_DECLARED", payload: {} }, schema);
  assert.ok(issues.some((item) => item.field === "payload.quantity" && item.code === "required"));
});

test("未知事件类型会被拒绝", () => {
  const issues = validateEvent({ ...sample, event_type: "UNKNOWN" }, schema);
  assert.ok(issues.some((item) => item.field === "event_type" && item.code === "unsupported_value"));
});
