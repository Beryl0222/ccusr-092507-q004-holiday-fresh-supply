# 双节生鲜承诺清算

中秋与国庆相邻期间，批发市场同时面对蔬菜交易突增、渔船集中返港与水果到货高峰。
本服务记录货源批次、品类与等级、到货窗口、检验状态、损耗、供应承诺、采购需求、价格区间、
装卸能力与实际交收，保证：

- **任何可承诺量都从可解释的批次余额产生**——在途、待检、被其他市场锁定、质量封存都不能冒充可分配量；
- 临时补货不会把同一批货承诺两次（挂账按承诺记账、成交以批次为并发边界）；
- 质量封存、船期变化、到货短缺只重排尚未交收的部分，优先保障按**冻结版本**执行；
- 人工改派必须说明理由且不能突破数量守恒；
- 采购方重试、供应商补传回执、交收、出账、付款全部幂等；同业务号异内容进入争议；
- 两个采购方并发确认最后一份额度时只允许一个成交；
- 跨午夜费用、短交赔付、退补价按实际交收版本清算；已出账周期只能冲正；
- 财务批处理中断后继续未完成账项；任意一笔付款都能追到货源、检验、占用与交收事实；
- 运营可从 API 看见缺口为何形成。

## 目录

- `contracts/domain.schema.json`：事件信封、聚合类型、事件枚举与载荷必填约定。
- `data/sample.json`：可直接校验的中文联调样例。
- `src/contracts.js`：交换层契约校验（稳定错误结构、枚举、时区、版本、载荷约束）。
- `src/domain/quantities.js`：批次数量账本（守恒桶位 + 按承诺的软标记 + ATP 解释）。
- `src/domain/store.js`：仅追加事件存储、规范化 JSON/指纹、键级互斥、乐观并发。
- `src/domain/settlement.js`：交收清算纯函数（货款/短赔/退补价/跨午夜费）。
- `src/domain/projection.js`：从事件日志重建读模型。
- `src/domain/clearing.js`：承诺清算服务（幂等、争议、确认、冻结重排、改派、交收、冲正、批处理、付款追溯、缺口解释）。
- `src/api.js`：零依赖 HTTP 适配器（`GET /lots/:id`、`GET /gaps/:businessNo`、`GET /payments/:id/trace`、`POST /commands/:name`）。
- `src/cli.js`：契约校验命令行入口。
- `docs/domain.md`：领域对象、事件语义与不变量。
- `tests/`：契约边界、并发挤兑、重排优先级、清算冲正、批处理续跑、追溯与 HTTP API 测试。

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

## 快速体验

```js
import { ClearingService } from "./src/domain/clearing.js";

const service = new ClearingService();
service.declareLot({ lot_id: "lot-1", /* 品类/等级/数量/到货窗口/价格区间 */ });
service.lotArrived("lot-1", 1000);
service.inspect("lot-1", { inspection_id: "insp-1", result: "passed" });
service.snapshot().lots.get("lot-1").atp;        // { hard: 1000, ... }
service.explainGap("业务号");                     // 缺口拆解与成因
service.tracePayment("付款号");                   // 付款 → 账项 → 交收 → 占用 → 检验 → 货源
```
