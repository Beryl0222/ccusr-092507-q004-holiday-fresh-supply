# 领域约定

描述双节（中秋、国庆）生鲜批发市场的货源批次、供应承诺、采购需求、占用与实际交收，
保证**任何可承诺量都从可解释的批次余额产生**，承诺不被重复给出，清算以实际交收为准、全程可追溯。

## 分层

- 交换层（`src/contracts.js` + `contracts/domain.schema.json`）：事件信封、枚举、时间版本、事件专属必填载荷。
- 领域服务（`src/domain/`）：批次数量账本、幂等与争议、并发占用、冻结优先级重排、人工改派、交收清算、冲正、批处理续跑、付款追溯、缺口解释。

所有时间必须携带时区；版本号从 1 开始递增；交换层不替调用方改写输入。

## 聚合与事件

聚合：`supply_lot`（货源批次）、`handling_capacity`（装卸窗口能力）、`purchase_demand`（采购需求）、
`allocation_round`（分配轮次/冻结版本）、`allocation_commitment`（供应承诺及改派单）、
`settlement_entry`（清算账项/冲正账项）、`settlement_period`（出账周期）、`payment`（付款）、`dispute`（争议）。

事件：

| 事件 | 含义 |
| --- | --- |
| `LOT_DECLARED` | 供应商申报货源（品类、等级、单位、数量、到货窗口、价格区间） |
| `LOT_SCHEDULE_UPDATED` | 船期/车次变化 |
| `LOT_ARRIVED` | 实际到货（进入待检） |
| `LOT_INSPECTED` | 检验结果：`passed` / `quarantined` / `rejected` |
| `LOT_QUARANTINED` / `LOT_RELEASED` | 质量封存与解除 |
| `LOT_LOSS_RECORDED` | 损耗（可注明发生桶位 `stage`） |
| `LOT_SHORTAGE_RECORDED` | 到货短缺（默认在途；占用后过磅短缺用 `stage=allocated`） |
| `LOT_EXTERNAL_LOCKED` / `LOT_EXTERNAL_UNLOCKED` | 被其他市场锁定 / 解锁 |
| `CAPACITY_DECLARED` / `CAPACITY_RESERVED` / `CAPACITY_RELEASED` | 装卸能力申报、占用、释放 |
| `DEMAND_REGISTERED` | 采购需求登记（业务号幂等） |
| `PRIORITY_FROZEN` | 优先级冻结版本（规则、排序） |
| `COMMITMENT_PROPOSED` | 供应承诺挂账（从批次余额产生） |
| `COMMITMENT_ACKED` | 供应商回执补传（业务号幂等） |
| `ALLOCATION_CONFIRMED` | 采购方确认成交，硬占用批次额度 |
| `ALLOCATION_REARRANGED` | 封存/船期/短缺触发的重排（按冻结版本） |
| `ALLOCATION_REASSIGNED` | 人工改派（必须有理由与操作人） |
| `ALLOCATION_RELEASED` / `ALLOCATION_SHORTFALL_CLOSED` | 释放占用 / 缺口关单 |
| `DELIVERY_ACCEPTED` | 实际交收（交收号幂等） |
| `SETTLEMENT_POSTED` / `SETTLEMENT_REVERSED` | 出账 / 冲正 |
| `PERIOD_CLOSED` | 周期关账 |
| `PAYMENT_ISSUED` | 付款（携带逐账项溯源） |
| `DISPUTE_OPENED` / `DISPUTE_RESOLVED` | 争议开立与处理 |

## 批次数量守恒

每个批次在任何时刻满足：

```
declared = in_transit + pending_inspection + available + quarantined
         + external_locked + allocated + delivered + lost + short
```

供应承诺是软桶位（`available` / `pending_inspection` / `in_transit`）上**按承诺记录的再标记**：
随物理移动（到货、检验通过）按比例迁移；被封存、外锁、短缺、检验拒收抽走时按比例注销并记账。
投影结果里的 `conservation_ok` 与 `conservation_residual` 用于自检恒等式。

## 可承诺量（ATP）解释

`atp` 与 `atp_lines` 把供应商口中的"已备货"拆清楚：

- `hard`：已检验可分配、未被承诺挂账的**硬额度**——只有它可以立即确认成交。
- `soft_pending` / `soft_in_transit`：已到货待检 / 在途（含船期）的**软额度**，承诺可挂账但须等到货检验通过才能成交。
- `QUARANTINE_HOLD`、`EXTERNAL_LOCK` 被阻断；`LOSS`、`SHORTAGE` 为终态；`ALLOCATED`、`DELIVERED` 已被拿走。

`COMMITMENT_PROPOSED` 按 硬额度 → 待检 → 在途 的顺序挂账；挂账总量不得超过三池余量。
承诺价必须落在批次价格区间内，且不超过采购需求最高限价。

## 幂等与争议

- 采购需求重试、供应商回执补传、交收、出账、冲正、关账、付款都按业务号/单号幂等：同内容重放返回 `replayed`。
- **同一业务号携带不同内容**：不覆盖旧数据，开立 `DISPUTE_OPENED`（`IDEMPOTENCY_CONTENT_MISMATCH`），
  事件记录双方内容指纹（规范化 JSON 的 SHA-256），调用方收到冲突错误。
- 付款号对应账项集合变化同样被拒绝。

## 并发确认：最后一份额度只允许一个成交

- 确认成交只认物理硬额度（`available` 桶位），以货源批次为聚合做乐观并发：
  写入带期望版本号，版本不符抛 `VERSION_CONFLICT`；传输层用 `withLotLock` 对同批次请求排队
  （跨进程部署由数据库行锁 / SERIALIZABLE 事务承担）。
- 在途超报、到货缩水时，先确认者占物理硬额度；输家未被满足的承诺标记记为 `CONFIRM_CONTENTION`，
  随后由冻结优先级重排或缺口关单处理。承诺支持分批确认（渔船只到一部分先确认一部分）。

## 冻结版本与重排

- `PRIORITY_FROZEN` 固化分配轮次的规则与需求排序，生成 `freeze_version`；之后所有重排都按这个版本执行，
  不受实时排序变化影响。
- 质量封存、船期变化、到货短缺**只重排尚未交收的部分**：
  1. 已占用受损：用批次剩余 `allocated` 按冻结优先级顺序覆盖各承诺的未交收占用，排不上的即为受损量；
  2. 未确认承诺受损：被封存/短缺/外锁/拒收注销的承诺标记；
  3. 按优先级依次争抢替代批次（同品类、同等级、价格满足需求限价），替代量在本轮预占，不会补给两家；
  4. 仍补不上的部分 `short_closed`。
- 部分改挂到替代批次时生成 `split_commitment_id` 子承诺；交收、清算可分别落在不同批次上。

## 人工改派

- 必须给出 `reason` 与 `operator_id`；只允许同品类同等级需求之间改派；
- 改派量不得超过该承诺尚未交收的占用量；改派只换需求方，**批次物理桶位不变**（数量守恒）。

## 交收与清算

- `DELIVERY_ACCEPTED` 实交量不得超过未交收占用量；支持分批交收。
- 清算（`settlement.js`）只以**实际交收版本**计算，冻结版本仅用于优先级与追溯：
  - `BASE` 货款 = 实交量 × 承诺价；
  - `SHORTFALL_COMPENSATION` 短交赔付 = (承诺量 − 实交量) × 费率（负值）；
  - `PRICE_ADJUST` 退补价 = 实交量 × (结算价 − 承诺价)；
  - `OVERNIGHT_HANDLING` 跨午夜装卸费：实际交收时刻与到货窗口按 `Asia/Shanghai` 自然日比较，跨日才计。
- 周期关账（`PERIOD_CLOSED`）后拒绝再出账；历史周期的调整只能走 `SETTLEMENT_REVERSED` 冲正（全额反向、幂等）。
- 财务批处理按交收号逐条过账，中断后重跑同一批：已过账的重放，只补未完成账项。

## 付款追溯与缺口解释

- `PAYMENT_ISSUED` 的金额由账项集合求和得到，`provenance` 逐账项记录
  周期、费用行、承诺（业务号、需求、冻结版本）、实际交收（单号、数量、时刻）、
  货源批次（供应商、品类等级、申报量、检验记录、封存、ATP 因子）。
  任意一笔付款都可经 `tracePayment` 追到货源、检验、占用与交收事实。
- `explainGap(businessNo)` 返回需求量、已交、缺口及拆解（未交收占用/已短关/已挂未确认/完全未覆盖），
  每个承诺带完整事件史与缺口成因（封存、外锁、短缺、损耗、在途待检），供运营从 API 解释缺口为何形成。
