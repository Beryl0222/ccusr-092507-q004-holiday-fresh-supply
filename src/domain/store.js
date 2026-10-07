import { createHash } from "node:crypto";

// 规范化 JSON：对象键递归排序，保证同内容字节一致（幂等指纹用）。
export function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJSON(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
}

export function contentFingerprint(value) {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

export class ConcurrencyConflict extends Error {
  constructor(streamId, expected, actual) {
    super(`聚合 ${streamId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.name = "ConcurrencyConflict";
    this.code = "VERSION_CONFLICT";
    this.expected = expected;
    this.actual = actual;
  }
}

// 仅追加的事件存储；生产实现替换为数据库表，接口保持不变。
// 所有数量事件以货源批次为聚合流，确认成交的乐观锁因此直接作用于批次版本。
export class InMemoryEventStore {
  constructor() {
    this.streams = new Map();
    this.seq = 0;
  }

  append(event, expectedVersion) {
    const streamId = event.aggregate_id;
    const stream = this.streams.get(streamId) ?? [];
    if (expectedVersion !== undefined && stream.length !== expectedVersion) {
      throw new ConcurrencyConflict(streamId, expectedVersion, stream.length);
    }
    const stored = { ...event, version: stream.length + 1, seq: ++this.seq };
    stream.push(stored);
    this.streams.set(streamId, stream);
    return stored;
  }

  read(streamId) {
    return (this.streams.get(streamId) ?? []).map((event) => ({ ...event }));
  }

  exists(streamId) {
    return this.streams.has(streamId);
  }

  all() {
    return [...this.streams.values()]
      .flat()
      .toSorted((left, right) => left.seq - right.seq)
      .map((event) => ({ ...event }));
  }
}

// 逐键互斥：同一货源批次上的确认/重排串行化，跨批次可并行。
export class KeyedMutex {
  constructor() {
    this.locks = new Map();
  }

  async run(key, task) {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this.locks.set(key, gate);
    try {
      return await task();
    } finally {
      this.locks.delete(key);
      release();
    }
  }
}
