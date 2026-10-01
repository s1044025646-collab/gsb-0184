// HTTP API：单状态求解、混风、盘管、过程链执行/查询、工况比较、导入导出。
// 仅使用 node:http，无外部依赖。所有错误返回 { error: { code, message, node } }。
import * as http from "node:http";
import { PsychroError, StateInput, solveState } from "./psychro";
import { coolingCoil, mix, sensible } from "./processes";
import { executeChain, Step } from "./engine";
import { Store } from "./store";
import { exportCsv, exportJson, parseImport } from "./importExport";

interface ApiError {
  code: string;
  message: string;
  node?: string;
}

function toApiError(e: unknown): { status: number; body: { error: ApiError } } {
  if (e instanceof PsychroError) {
    const status =
      e.code === "NOT_FOUND" ? 404 : e.code === "MISSING_INPUT" || e.code === "INVALID_INPUT" || e.code === "OUT_OF_RANGE" || e.code === "SUPER_SATURATED" || e.code === "MIX_SUPER_SATURATED" || e.code === "CYCLE_DETECTED" ? 400 : 500;
    return { status, body: { error: { code: e.code, message: e.message, node: e.node } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) } },
  };
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new PsychroError("INVALID_INPUT", "请求体不是合法 JSON", "body"));
      }
    });
    req.on("error", reject);
  });
}

function need(obj: Record<string, unknown>, keys: string[], node: string): void {
  for (const k of keys) {
    if (obj[k] === undefined || obj[k] === null) {
      throw new PsychroError("MISSING_INPUT", `缺少必需字段 "${k}"`, `${node}.${k}`);
    }
  }
}

export function createServer(store: Store): http.Server {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
      res.writeHead(status, {
        "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
        ...headers,
      });
      res.end(text);
    };
    try {
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/api/health") {
        return send(200, { ok: true });
      }
      if (method === "GET" && path === "/api/param-versions") {
        return send(200, { paramVersions: store.listParamVersions() });
      }

      if (method === "POST" && path === "/api/state") {
        const body = (await readBody(req)) as StateInput & { save?: boolean };
        need(body as Record<string, unknown>, ["p", "t"], "state");
        const state = solveState(body, "state");
        const id = body.save === false ? null : store.saveState(body, state);
        return send(200, { id, state });
      }

      if (method === "POST" && path === "/api/mix") {
        const body = (await readBody(req)) as {
          p: number;
          streams: { state: StateInput; mDa: number }[];
        };
        need(body as unknown as Record<string, unknown>, ["p", "streams"], "mix");
        const streams = body.streams.map((s, i) => ({
          state: solveState(s.state, `mix.streams[${i}].state`),
          mDa: s.mDa,
        }));
        const result = mix(streams, body.p, "mix");
        const id = store.saveState(body, result);
        return send(200, { id, ...result });
      }

      if (method === "POST" && path === "/api/coil") {
        const body = (await readBody(req)) as {
          state: StateInput;
          mDa: number;
          tSurface: number;
          bypassFactor: number;
        };
        need(body as unknown as Record<string, unknown>, ["state", "mDa", "tSurface", "bypassFactor"], "coil");
        const sIn = solveState(body.state, "coil.state");
        const result = coolingCoil({ state: sIn, mDa: body.mDa }, body.tSurface, body.bypassFactor, "coil");
        const id = store.saveState(body, result);
        return send(200, { id, inlet: sIn, ...result });
      }

      if (method === "POST" && path === "/api/sensible") {
        const body = (await readBody(req)) as { state: StateInput; mDa: number; tOut: number };
        need(body as unknown as Record<string, unknown>, ["state", "mDa", "tOut"], "sensible");
        const sIn = solveState(body.state, "sensible.state");
        const result = sensible({ state: sIn, mDa: body.mDa }, body.tOut, "sensible");
        const id = store.saveState(body, result);
        return send(200, { id, inlet: sIn, ...result });
      }

      if (method === "POST" && path === "/api/chains") {
        const body = (await readBody(req)) as { name: string; steps: Step[] };
        need(body as unknown as Record<string, unknown>, ["name", "steps"], "chain");
        const records = executeChain(body.steps);
        const { chainId, version } = store.saveChainExecution(body.name, records);
        return send(200, { chainId, version, steps: records });
      }

      const chainMatch = path.match(/^\/api\/chains\/(\d+)$/);
      if (method === "GET" && chainMatch) {
        const version = url.searchParams.get("version");
        const chain = store.getChain(Number(chainMatch[1]), version ? Number(version) : undefined);
        if (!chain) {
          throw new PsychroError("NOT_FOUND", `过程链 ${chainMatch[1]} 不存在`, "chainId");
        }
        return send(200, chain);
      }

      if (method === "GET" && path === "/api/chains") {
        return send(200, { chains: store.listChains() });
      }

      const stateMatch = path.match(/^\/api\/states\/(\d+)$/);
      if (method === "GET" && stateMatch) {
        const st = store.getState(Number(stateMatch[1]));
        if (!st) throw new PsychroError("NOT_FOUND", `状态点 ${stateMatch[1]} 不存在`, "stateId");
        return send(200, st);
      }

      if (method === "POST" && path === "/api/compare") {
        const body = (await readBody(req)) as {
          state: StateInput;
          mDa: number;
          cases: { name?: string; tSurface: number; bypassFactor: number }[];
        };
        need(body as unknown as Record<string, unknown>, ["state", "mDa", "cases"], "compare");
        const sIn = solveState(body.state, "compare.state");
        const results = body.cases.map((c, i) => {
          const r = coolingCoil({ state: sIn, mDa: body.mDa }, c.tSurface, c.bypassFactor, `compare.cases[${i}]`);
          return { name: c.name ?? `case${i + 1}`, tSurface: c.tSurface, bypassFactor: c.bypassFactor, ...r };
        });
        return send(200, { inlet: sIn, mDa: body.mDa, results });
      }

      if (method === "POST" && path === "/api/import") {
        const body = (await readBody(req)) as { format: string; content: string };
        need(body as unknown as Record<string, unknown>, ["format", "content"], "import");
        const imported = parseImport(body.format, body.content);
        const saved = imported.map((item) => {
          const state = solveState(item as StateInput, "import");
          return { id: store.saveState(item, state), state };
        });
        return send(200, { imported: saved.length, states: saved });
      }

      if (method === "GET" && path === "/api/export") {
        const format = url.searchParams.get("format") ?? "json";
        const chainId = url.searchParams.get("chainId");
        if (chainId) {
          const chain = store.getChain(Number(chainId));
          if (!chain) throw new PsychroError("NOT_FOUND", `过程链 ${chainId} 不存在`, "chainId");
          if (format === "csv") {
            return send(200, exportCsv(chain.steps as Record<string, unknown>[]), {
              "content-type": "text/csv; charset=utf-8",
            });
          }
          return send(200, exportJson(chain));
        }
        return send(200, exportJson({ chains: store.listChains() }));
      }

      throw new PsychroError("NOT_FOUND", `未知路由 ${method} ${path}`, "route");
    } catch (e) {
      const { status, body } = toApiError(e);
      send(status, body);
    }
  };
  return http.createServer((req, res) => {
    void handler(req, res);
  });
}

export function startServer(port: number, dbPath: string): http.Server {
  const store = new Store(dbPath);
  const server = createServer(store);
  server.listen(port, () => {
    console.log(`湿空气计算服务已启动: http://localhost:${port} (数据库: ${dbPath})`);
  });
  server.on("close", () => store.close());
  return server;
}
