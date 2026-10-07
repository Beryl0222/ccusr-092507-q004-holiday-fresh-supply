import { createServer } from "node:http";

import { DomainRejected } from "./domain/clearing.js";
import { ConcurrencyConflict } from "./domain/store.js";

// 零依赖 HTTP 适配器：把清算服务暴露为 JSON API。
// 生产部署时替换为公司网关框架，命令/查询语义保持不变。
export function createApi(service) {
  const readJson = (request) => new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("请求体过大"));
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });

  const send = (response, status, payload) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  };

  return async function handler(request, response) {
    const url = new URL(request.url, "http://localhost");
  try {
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && url.pathname.startsWith("/gaps/")) {
        const businessNo = decodeURIComponent(url.pathname.slice("/gaps/".length));
        return send(response, 200, service.explainGap(businessNo));
      }
      if (request.method === "GET" && url.pathname.startsWith("/payments/") && url.pathname.endsWith("/trace")) {
        const paymentId = decodeURIComponent(url.pathname.slice("/payments/".length, -"/trace".length));
        return send(response, 200, service.tracePayment(paymentId));
      }
      const lotMatch = url.pathname.match(/^\/lots\/(.+)$/);
      if (request.method === "GET" && lotMatch) {
        const lot = service.snapshot().lots.get(decodeURIComponent(lotMatch[1]));
        if (!lot) return send(response, 404, { code: "LOT_NOT_FOUND" });
        return send(response, 200, {
          lot_id: lot.lot_id,
          declared: lot.declared,
          buckets: lot.buckets,
          atp: lot.atp,
          atp_lines: lot.atp_lines,
          inspections: lot.inspections,
          holds: lot.holds,
          conservation_ok: lot.conservation_ok,
        });
      }
      const commandMatch = url.pathname.match(/^\/commands\/([a-z_]+)$/);
      if (request.method === "POST" && commandMatch) {
        const command = commandMatch[1];
        const method = camelCase(command);
        if (typeof service[method] !== "function") return send(response, 404, { code: "UNKNOWN_COMMAND", command });
        const cmd = await readJson(request);
        const result = await service[method](cmd);
        return send(response, 200, serializeResult(result));
      }
      return send(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof DomainRejected) {
        return send(response, error.code === "IDEMPOTENCY_CONTENT_MISMATCH" ? 409 : 422, {
          code: error.code, message: error.message, details: error.details,
        });
      }
      if (error instanceof ConcurrencyConflict) {
        return send(response, 409, { code: error.code, message: error.message, expected: error.expected, actual: error.actual });
      }
      return send(response, 500, { code: "INTERNAL", message: error.message });
    }
  };
}

function camelCase(snake) {
  return snake.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function serializeResult(result) {
  if (result && typeof result === "object") {
    return JSON.parse(JSON.stringify(result, (key, value) => (typeof value === "bigint" ? Number(value) : value)));
  }
  return { result };
}

export function startApi(service, port = 0) {
  return new Promise((resolve) => {
    const instance = createServer(createApi(service));
    instance.listen(port, () => resolve({
      server: instance,
      port: instance.address().port,
      close: () => instance.close(),
    }));
  });
}
