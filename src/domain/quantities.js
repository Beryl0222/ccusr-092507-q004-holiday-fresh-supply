// 批次数量账本：把一个货源批次在全生命周期内的数量投影成互斥桶位。
// 守恒恒等式（任何时刻）：
// declared = in_transit + pending_inspection + quarantined + external_locked
//          + available + allocated + delivered + lost + short
// 供应承诺是软桶位（available/pending_inspection/in_transit）上按承诺记录的再标记，
// 随物理移动按比例迁移，随封存/外锁/短缺/拒收按比例受损，不重复占用物理数量。

export const POOLS = [
  "in_transit",
  "pending_inspection",
  "available",
  "quarantined",
  "external_locked",
  "allocated",
  "delivered",
  "lost",
  "short",
];

const SOFT_POOLS = ["available", "pending_inspection", "in_transit"];

function emptyBuckets() {
  return Object.fromEntries(POOLS.map((pool) => [pool, 0]));
}

function move(buckets, from, to, quantity) {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`非法数量: ${quantity}`);
  }
  if (quantity - buckets[from] > 1e-9) {
    throw new Error(`桶位 ${from} 余额不足：需要 ${quantity}，现有 ${buckets[from]}`);
  }
  buckets[from] -= quantity;
  buckets[to] += quantity;
}

function newTags() {
  return { available: 0, pending_inspection: 0, in_transit: 0 };
}

// 按比例把物理移动对应的承诺标记从一个软桶迁到另一个软桶，末位吸收舍入余量。
function migrateAllTags(tagsByCommitment, from, to, quantity, bucketsBefore) {
  if (bucketsBefore[from] <= 0) return;
  const entries = [...tagsByCommitment.entries()].filter(([, tags]) => tags[from] > 1e-9);
  if (entries.length === 0) return;
  if (quantity >= bucketsBefore[from] - 1e-9) {
    for (const [, tags] of entries) {
      tags[to] += tags[from];
      tags[from] = 0;
    }
    return;
  }
  const ratio = quantity / bucketsBefore[from];
  let moved = 0;
  entries.forEach(([, tags], index) => {
    let take;
    if (index === entries.length - 1) take = Math.min(tags[from], Math.max(0, quantity - moved));
    else take = tags[from] * ratio;
    take = Math.round(take * 1e9) / 1e9;
    tags[from] -= take;
    tags[to] += take;
    moved += take;
  });
}

export function projectLot(events = [], lotId = null) {
  const buckets = emptyBuckets();
  const tagsByCommitment = new Map();
  const holds = new Map();
  const locks = new Map();
  const inspections = [];
  // 每个承诺因封存/外锁/短缺/拒收而损失的承诺量，供重排与缺口解释使用。
  const impairedPromises = new Map();
  let declared = 0;
  let arrivalWindow = null;
  let vesselTripId = null;
  // 已确认占用被封存/损耗侵蚀：必须按冻结优先级重排尚未交收的部分。
  let impairment = 0;

  const tagsOf = (commitmentId) => {
    if (!tagsByCommitment.has(commitmentId)) tagsByCommitment.set(commitmentId, newTags());
    return tagsByCommitment.get(commitmentId);
  };
  const tagsIn = (pool) => [...tagsByCommitment.values()].reduce((sum, tags) => sum + tags[pool], 0);

  // 软桶位数量被封存/外锁/短缺/拒收抽走时（必须在物理 move 之前调用），
  // 按比例注销对应承诺标记并记账。
  function impairTags(pool, quantity, reason, commitmentId = null) {
    if (!(pool in newTags()) || buckets[pool] <= 0) return;
    const base = buckets[pool]; // 移动前桶位量
    const targets = commitmentId
      ? [[commitmentId, tagsOf(commitmentId)]].filter(([, tags]) => tags[pool] > 0)
      : [...tagsByCommitment.entries()].filter(([, tags]) => tags[pool] > 0);
    for (const [cid, tags] of targets) {
      const share = Math.min(tags[pool], tags[pool] * Math.min(1, quantity / base));
      if (share <= 1e-9) continue;
      tags[pool] -= share;
      const list = impairedPromises.get(cid) ?? [];
      list.push({ quantity: Math.round(share * 1e9) / 1e9, pool, reason });
      impairedPromises.set(cid, list);
    }
  }

  for (const event of events) {
    const p = event.payload ?? {};
    const q = Number(p.quantity ?? 0);
    switch (event.event_type) {
      case "LOT_DECLARED":
        declared += q;
        buckets.in_transit += q;
        arrivalWindow = p.arrival_window;
        break;
      case "LOT_SCHEDULE_UPDATED":
        vesselTripId = p.vessel_trip_id;
        arrivalWindow = p.arrival_window;
        break;
      case "LOT_ARRIVED": {
        const before = { ...buckets };
        move(buckets, "in_transit", "pending_inspection", q);
        migrateAllTags(tagsByCommitment, "in_transit", "pending_inspection", q, before);
        break;
      }
      case "LOT_INSPECTED": {
        inspections.push({ inspection_id: p.inspection_id, result: p.result });
        const quantity = p.quantity ?? buckets.pending_inspection;
        if (p.result === "passed") {
          const before = { ...buckets };
          move(buckets, "pending_inspection", "available", quantity);
          migrateAllTags(tagsByCommitment, "pending_inspection", "available", quantity, before);
        } else if (p.result === "quarantined") {
          impairTags("pending_inspection", quantity, "INSPECTION_QUARANTINED");
          move(buckets, "pending_inspection", "quarantined", quantity);
          holds.set(p.inspection_id, { hold_id: p.inspection_id, quantity, from_allocated: 0 });
        } else {
          impairTags("pending_inspection", quantity, "INSPECTION_REJECTED");
          move(buckets, "pending_inspection", "lost", quantity);
        }
        break;
      }
      case "LOT_QUARANTINED": {
        const fromAvailable = Math.min(buckets.available, q);
        if (fromAvailable > 0) {
          impairTags("available", fromAvailable, "QUALITY_HOLD");
          move(buckets, "available", "quarantined", fromAvailable);
        }
        let fromAllocated = 0;
        if (q - fromAvailable > 1e-9) {
          fromAllocated = Math.min(buckets.allocated, q - fromAvailable);
          move(buckets, "allocated", "quarantined", fromAllocated);
          impairment += fromAllocated;
        }
        const priorHold = holds.get(p.hold_id);
        holds.set(p.hold_id, {
          hold_id: p.hold_id,
          quantity: (priorHold?.quantity ?? 0) + fromAvailable + fromAllocated,
          from_allocated: (priorHold?.from_allocated ?? 0) + fromAllocated,
        });
        break;
      }
      case "LOT_RELEASED": {
        move(buckets, "quarantined", "available", q);
        const hold = holds.get(p.hold_id);
        if (hold) {
          const relieved = Math.min(hold.from_allocated, q);
          impairment = Math.max(0, impairment - relieved);
        }
        break;
      }
      case "LOT_LOSS_RECORDED": {
        const stage = p.stage ?? "available";
        if (stage in newTags()) impairTags(stage, q, "LOSS");
        move(buckets, stage, "lost", q);
        if (stage === "allocated") impairment += q;
        break;
      }
      case "LOT_SHORTAGE_RECORDED": {
        // 默认短缺发生在途；占用后过磅发现短缺时 stage=allocated。
        const stage = p.stage ?? "in_transit";
        if (stage in newTags()) impairTags(stage, q, "SHORTAGE");
        move(buckets, stage, "short", q);
        if (stage === "allocated") impairment += q;
        break;
      }
      case "LOT_EXTERNAL_LOCKED": {
        const source = p.source_pool ?? "available";
        if (source in newTags()) impairTags(source, q, "EXTERNAL_LOCK");
        move(buckets, source, "external_locked", q);
        break;
      }
      case "LOT_EXTERNAL_UNLOCKED": {
        const lock = locks.get(p.market_ref);
        const source = lock?.source_pool ?? "available";
        move(buckets, "external_locked", source, q);
        break;
      }
      case "COMMITMENT_PROPOSED": {
        const tags = tagsOf(p.commitment_id);
        let rest = q;
        for (const pool of SOFT_POOLS) {
          const free = buckets[pool] - tagsIn(pool);
          const take = Math.min(Math.max(free, 0), rest);
          tags[pool] += take;
          rest -= take;
          if (rest <= 1e-9) break;
        }
        if (rest > 1e-9) throw new Error("可承诺量不足，无法挂起供应承诺");
        break;
      }
      case "ALLOCATION_CONFIRMED": {
        // 成交以物理硬额度为准（服务层互斥串行化，先确认者先占）。
        move(buckets, "available", "allocated", q);
        const tags = tagsOf(p.commitment_id);
        const own = Math.min(tags.available, q);
        tags.available -= own;
        // 超出本承诺份额的部分，来自物理收缩后仍挂在其他承诺上的标记：注销并记为挤兑受损。
        let deficit = q - own;
        if (deficit > 1e-9) {
          for (const [cid, t] of [...tagsByCommitment.entries()].filter(([id, t]) => id !== p.commitment_id && t.available > 1e-9)) {
            if (deficit <= 1e-9) break;
            const take = Math.min(t.available, deficit);
            t.available -= take;
            deficit -= take;
            const list = impairedPromises.get(cid) ?? [];
            list.push({ quantity: Math.round(take * 1e9) / 1e9, pool: "available", reason: "CONFIRM_CONTENTION" });
            impairedPromises.set(cid, list);
          }
        }
        break;
      }
      case "ALLOCATION_REARRANGED": {
        // 受损数量在触发事件（封存/损耗）时已经离开 allocated，源批次不重复移动；
        // 重排只在替代批次上把 available 转成 allocated，并在批次内补位时做一次转换。
        for (const item of p.items ?? []) {
          if (item.action === "moved" && item.to_lot_id === lotId && item.from_lot_id !== lotId) {
            move(buckets, "available", "allocated", item.quantity);
          } else if (item.action === "moved" && item.from_lot_id === lotId && item.to_lot_id === lotId) {
            move(buckets, "available", "allocated", item.quantity);
          }
        }
        // 本批次已受损占用被重排处理（补位或短关）后，解除受损标记。
        const resolved = (p.items ?? [])
          .filter((item) => item.from_lot_id === lotId && item.stage !== "promise")
          .reduce((sum, item) => sum + (item.action === "moved" || item.action === "short_closed" ? item.quantity : 0), 0);
        if (resolved > 0) impairment = Math.max(0, impairment - resolved);
        break;
      }
      case "ALLOCATION_REASSIGNED":
        // 人工改派只转移需求方，批次桶位不变（占用守恒）。
        break;
      case "ALLOCATION_RELEASED":
      case "ALLOCATION_SHORTFALL_CLOSED":
        move(buckets, "allocated", "available", q);
        break;
      case "DELIVERY_ACCEPTED":
        if (p.lot_id && p.lot_id !== lotId) break;
        move(buckets, "allocated", "delivered", q);
        break;
      default:
        break;
    }

    if (event.event_type === "LOT_EXTERNAL_LOCKED") {
      locks.set(p.market_ref, { market_ref: p.market_ref, quantity: q, source_pool: p.source_pool ?? "available" });
    }
  }

  const promised = SOFT_POOLS.reduce((sum, pool) => sum + tagsIn(pool), 0);
  const promisedByPool = Object.fromEntries(SOFT_POOLS.map((pool) => [pool, tagsIn(pool)]));
  const physical = POOLS.reduce((sum, pool) => sum + buckets[pool], 0);
  const conservationResidual = Math.abs(physical - declared);

  return {
    declared,
    arrival_window: arrivalWindow,
    vessel_trip_id: vesselTripId,
    buckets,
    promised,
    promised_by_pool: promisedByPool,
    commitment_tags: Object.fromEntries([...tagsByCommitment.entries()].map(([id, tags]) => [id, { ...tags }])),
    impaired_promises: [...impairedPromises.entries()].map(([commitment_id, list]) => ({
      commitment_id,
      quantity: list.reduce((sum, item) => sum + item.quantity, 0),
      details: list,
    })),
    holds: [...holds.values()],
    locks: [...locks.values()],
    inspections,
    impairment,
    conservation_residual: conservationResidual,
    conservation_ok: conservationResidual <= 1e-9,
    ...atpView(buckets, promisedByPool),
  };
}

// 可承诺量（ATP）解释：每一份承诺都必须能指到具体桶位。
export function atpView(buckets, promisedByPool = { available: 0, pending_inspection: 0, in_transit: 0 }) {
  return {
    atp: {
      // 采购方现在就能确认成交的硬额度（已扣除全部挂账承诺）。
      hard: Math.max(0, buckets.available - (promisedByPool.available ?? 0)),
      // 供应承诺可以挂账、但需等到货/检验通过才能确认的软额度。
      soft_pending: Math.max(0, buckets.pending_inspection - (promisedByPool.pending_inspection ?? 0)),
      soft_in_transit: Math.max(0, buckets.in_transit - (promisedByPool.in_transit ?? 0)),
      hard_promised_open: promisedByPool.available ?? 0,
    },
    atp_lines: [
      { code: "AVAILABLE", quantity: buckets.available, convertible: "hard", note: "已检验可分配" },
      { code: "PENDING_INSPECTION", quantity: buckets.pending_inspection, convertible: "soft", note: "已到货待检" },
      { code: "IN_TRANSIT", quantity: buckets.in_transit, convertible: "soft", note: "在途（含船期）" },
      { code: "QUARANTINE_HOLD", quantity: buckets.quarantined, convertible: "blocked", note: "质量封存" },
      { code: "EXTERNAL_LOCK", quantity: buckets.external_locked, convertible: "blocked", note: "被其他市场锁定" },
      { code: "LOSS", quantity: buckets.lost, convertible: "terminal", note: "损耗/检验拒收" },
      { code: "SHORTAGE", quantity: buckets.short, convertible: "terminal", note: "到货短缺" },
      { code: "ALLOCATED", quantity: buckets.allocated, convertible: "taken", note: "已确认占用" },
      { code: "DELIVERED", quantity: buckets.delivered, convertible: "taken", note: "已实际交收" },
    ],
  };
}

// 供应承诺挂账时按 硬额度 → 待检 → 在途 的顺序选择来源桶位。
export function promiseSources(view, quantity) {
  const plan = [];
  let rest = quantity;
  const candidates = [
    ["available", view.atp.hard],
    ["pending_inspection", view.atp.soft_pending],
    ["in_transit", view.atp.soft_in_transit],
  ];
  for (const [pool, free] of candidates) {
    const take = Math.min(Math.max(free, 0), rest);
    if (take > 1e-9) plan.push({ pool, quantity: take });
    rest -= take;
  }
  return { plan, shortage: Math.max(rest, 0) };
}

export function projectCapacity(events = []) {
  let total = 0;
  let reserved = 0;
  let windowId = null;
  for (const event of events) {
    if (event.event_type === "CAPACITY_DECLARED") {
      total += event.payload.quantity;
      windowId = event.payload.window_id;
    } else if (event.event_type === "CAPACITY_RESERVED") reserved += event.payload.quantity;
    else if (event.event_type === "CAPACITY_RELEASED") reserved -= event.payload.quantity;
  }
  return { window_id: windowId, total, reserved, remaining: total - reserved };
}
