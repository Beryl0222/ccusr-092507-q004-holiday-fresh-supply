# 领域约定

描述节日生鲜货源、供应承诺与实际交收事件，保证批次数量和清算依据可追溯。

聚合对象包括`supply_lot`、`purchase_demand`、`allocation_commitment`、`settlement_entry`、`handling_capacity`、`priority_rules`、`dispute`。所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。

同一事件标识的幂等与冲突处理属于上层业务服务职责；交换层只负责稳定报告结构、枚举、时间、版本和必需载荷问题。

## 批次余额

供应商口中的"已备货"被拆成可解释的桶，任何可承诺量只能从`in_transit`、`pending_inspection`、`allocatable`三个桶产生，`locked_external`（被其他市场锁定）、`quarantined`（质量封存）、`lost`（损耗）、`shortage`（到货短缺）永远不参与承诺：

```
申报 → in_transit → pending_inspection → allocatable → reserved → delivered
              ↘ shortage        ↘ quarantined      ↘ lost（各桶均可记损耗）
```

每个批次各桶之和恒等于申报数量（数量守恒）。成交承诺记录其来源组成（现货/待检/在途各多少），到货与检验只改写来源状态，不改变总量。

## 承诺生命周期

`offered`（报价，不占余额）→ `confirmed`（成交，原子占用批次余额与装卸能力）→ `partially_delivered` / `delivered`；`released`（释放）、`stale`（事实变化后作废）。

- 报价只是计划，同一余额可以对多个需求报价；成交是原子闸门，两个采购方并发确认最后一份额度时只允许一个成交，余额或装卸能力不足的一方失败。
- 批次余额收缩（封存、损耗、短缺、改期）时，该批次未成交的报价一律作废，必须按新事实重新报价。

## 重排与改派

质量封存、船期变化、到货短缺只重排尚未交收的部分，已交收事实永不改动。缺口先扣未承诺余额，不足时按冻结版本的优先保障规则逆序牺牲未交收承诺（低优先级买家先承担），释放的数量在其他同品类同等级批次上重新成交，并保留`replanned_from`追溯链。人工改派必须说明理由并登记经办人，先校验目标批次余额再释放与占用，不能突破数量守恒。

## 幂等与争议

- 采购需求按`business_key`幂等：同内容重试返回原需求，异内容进入争议（`DISPUTE_RAISED`），不覆盖已登记需求。
- 供应商回执按`business_key`幂等，异内容同样进入争议。
- 实际交收按`delivery_ref`幂等，同内容重传不再记账，异内容报错。
- 清算账项按`period_id + commitment + 费用类型 + 交收版本`键幂等，批处理中断后继续未完成账项。

## 清算

账项类型：`goods`（货款）、`night_fee`（跨午夜费用，按交收当地 0–6 点窗口计）、`short_penalty`（短交赔付，交付期限过后仍未交收的部分）、`price_adjustment`（退补价，交收最终价与约定价之差）。全部以实际交收版本为计算依据。已出账周期不改动原账项，只通过冲正（`SETTLEMENT_REVERSED`，金额为负）调整，冲正账项不可再次冲正。

## 事件载荷

- `LOT_DECLARED`：还需包含 `supplier_id`, `category`, `grade`, `quantity`, `arrival_window`。
- `LOT_ARRIVED`：还需包含 `arrived_quantity`；末次到货后不足部分记 `LOT_SHORTAGE_RECORDED`（含 `quantity`）。
- `LOT_INSPECTED`：还需包含 `passed_quantity`, `quarantined_quantity`。
- `LOT_QUARANTINED` / `LOT_LOSS_RECORDED` / `LOT_RESCHEDULED`：还需包含数量与原因。
- `CAPACITY_RESERVED`：还需包含 `demand_id`, `quantity`。
- `COMMITMENT_OFFERED`：还需包含 `demand_id`, `lot_id`, `quantity`, `rule_version`。
- `COMMITMENT_REASSIGNED`：还需包含 `to_lot_id`, `quantity`, `reason`。
- `DELIVERY_ACCEPTED`：还需包含 `commitment_id`, `delivery_ref`, `version`, `quantity`。
- `SETTLEMENT_POSTED`：还需包含 `period_id`, `amount`；`SETTLEMENT_REVERSED`还需包含 `reverses`。

完整清单见`contracts/domain.schema.json`的`payload_required_by_event`。

## 运营与追溯 API

- `explainGap(demand_id)`：按批次逐桶列出余额去向（在途、待检、封存、锁定、占用……），解释缺口为何形成。
- `tracePayment(entry_id)`：从任意一笔账项追到货源、检验、占用和交收事实。
- `verifyInvariants()`：校验批次守恒、占用桶与承诺一致、装卸能力与承诺一致、来源组成一致。
