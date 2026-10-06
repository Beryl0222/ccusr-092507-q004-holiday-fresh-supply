# 双节生鲜承诺清算

描述节日生鲜货源、供应承诺与实际交收事件，保证批次数量和清算依据可追溯。

## 目录

- `contracts/domain.schema.json`：事件信封、对象类型和事件载荷约定。
- `data/sample.json`：可直接校验的中文联调样例。
- `src/contracts.js`：契约校验。
- `src/service.js`：承诺清算服务——批次余额、承诺、重排、幂等、清算与追溯。
- `src/cli.js`：命令行校验入口。
- `tests/`：契约边界测试与服务层业务不变量测试。
- `docs/domain.md`：领域对象、批次余额、承诺生命周期与事件语义。

## 服务层

`createClearingService({ schema })` 返回清算服务，所有状态变更都发出符合契约的事件：

- 货源：`declareLot` / `recordArrival` / `recordInspection` / `quarantineLot` / `recordLoss` / `updateArrivalWindow`
- 需求与回执：`submitDemand` / `receiveReceipt`（业务号幂等，异内容进入争议）
- 承诺：`allocateDemand` / `confirmCommitment` / `recordDelivery` / `reassignCommitment`
- 规则：`setPriorityRules`（冻结版本，重排按冻结版本执行）
- 装卸能力：`declareHandlingCapacity`
- 清算：`runSettlementBatch`（中断后可继续）/ `reverseEntry`（冲正）
- 运营：`explainGap` / `tracePayment` / `verifyInvariants`

## 测试

```bash
npm test
```

## 编译检查

```bash
npm run build
```

## 样例校验

```bash
npm run check:sample
```

命令成功时输出 `valid`；校验失败时逐行输出字段、代码和中文说明，并以非零状态结束。
