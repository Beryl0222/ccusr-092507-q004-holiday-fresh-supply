# 领域约定

描述节日生鲜货源、供应承诺与实际交收事件，保证批次数量和清算依据可追溯。

聚合对象包括`supply_lot`、`purchase_demand`、`allocation_commitment`、`settlement_entry`。事件类型包括`LOT_DECLARED`、`LOT_INSPECTED`、`CAPACITY_RESERVED`、`DELIVERY_ACCEPTED`、`SETTLEMENT_POSTED`。所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。

## 事件载荷

- `LOT_DECLARED`：还需包含 `quantity`, `arrival_window`。
- `CAPACITY_RESERVED`：还需包含 `demand_id`, `quantity`。
- `SETTLEMENT_POSTED`：还需包含 `period_id`, `amount`。

同一事件标识的幂等与冲突处理属于上层业务服务职责；交换层只负责稳定报告结构、枚举、时间、版本和必需载荷问题。
