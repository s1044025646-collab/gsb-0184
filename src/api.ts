/**
 * HTTP API（node:http，无外部依赖）。
 * 错误统一格式：{ "error": { "code", "message", "node" } }，node 可定位到具体输入字段。
 * 端口与数据目录可通过环境变量 PORT / PSYCHRO_DATA_DIR 或 config.json 配置。
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { PsychroError, solveState } from "./psychro";
import { coolingCoil, mixStreams, sensibleToTemperature } from "./processes";
import { ChainError, runAndSaveChain, snapshotChain } from "./chain";
import { Store } from "./store";

export interface Config { port: number; dataDir: string; }

export function loadConfig(): Config {
  let cfg: any = {};
  const p = path.resolve("config.json");
  if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    port: Number(process.env.PORT ?? cfg.port ?? 8321),
    dataDir: path.resolve(process.env.PSYCHRO_DATA_DIR ?? cfg.dataDir ?? "data"),
  };
}

function errBody(code: string, message: string, node?: string) {
  return { error: { code, message, node: node ?? null } };
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new ChainError("请求体不是合法 JSON", "body"); }
}

function toCsv(rows: any[], cols: string[]): string {
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
}

export function createServer(store: Store, config: Config) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, obj: any, csv = false) => {
      res.writeHead(code, { "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8" });
      res.end(csv ? obj : JSON.stringify(obj, null, 2));
    };
    try {
      const m = req.method ?? "GET";
      const seg = url.pathname.split("/").filter(Boolean); // e.g. ["api","chains","3","snapshot"]
      if (seg[0] !== "api") return send(404, errBody("NOT_FOUND", "未知路径", url.pathname));

      if (m === "POST" && seg[1] === "state") {
        const b = await readBody(req);
        const out = solveState(b.p ?? 101.325, b.state, "state");
        const id = b.save ? store.saveState(b.label ?? "state", b, out) : null;
        return send(200, { id, result: out });
      }
      if (m === "POST" && seg[1] === "mix") {
        const b = await readBody(req);
        const out = mixStreams(b.streams, b.p ?? 101.325);
        const id = b.save ? store.saveState(b.label ?? "mix", b, out) : null;
        return send(200, { id, result: out });
      }
      if (m === "POST" && seg[1] === "coil") {
        const b = await readBody(req);
        const out = coolingCoil(b.inlet, b.mda, b.Ts, b.BF, b.p ?? 101.325);
        const id = b.save ? store.saveState(b.label ?? "coil", b, out) : null;
        return send(200, { id, result: out });
      }
      if (m === "POST" && seg[1] === "heat") {
        const b = await readBody(req);
        const out = sensibleToTemperature(b.inlet, b.mda, b.Tout, b.p ?? 101.325);
        return send(200, { result: out });
      }
      if (m === "POST" && seg[1] === "chains" && seg.length === 2) {
        const b = await readBody(req);
        const r = runAndSaveChain(store, b.name ?? "chain", b.steps, b.p ?? 101.325);
        return send(200, { chainId: r.chainId, steps: r.executed });
      }
      if (m === "GET" && seg[1] === "chains" && seg.length === 2) return send(200, { chains: store.listChains() });
      if (m === "GET" && seg[1] === "chains" && seg.length === 3) {
        const c = store.getChain(Number(seg[2]));
        if (!c) return send(404, errBody("NOT_FOUND", `链 ${seg[2]} 不存在`, `chains[${seg[2]}]`));
        return send(200, c);
      }
      if (m === "POST" && seg[1] === "chains" && seg[3] === "snapshot") {
        const b = await readBody(req);
        const r = snapshotChain(store, Number(seg[2]), b.overrides ?? {}, b.p ?? 101.325, b.name);
        return send(200, { chainId: r.chainId, steps: r.executed });
      }
      if (m === "GET" && seg[1] === "states" && seg.length === 2) return send(200, { states: store.listStates() });
      if (m === "GET" && seg[1] === "states" && seg.length === 3) {
        const s = store.getState(Number(seg[2]));
        if (!s) return send(404, errBody("NOT_FOUND", `状态 ${seg[2]} 不存在`, `states[${seg[2]}]`));
        return send(200, s);
      }
      if (m === "POST" && seg[1] === "compare") {
        const b = await readBody(req);
        const chains = (b.chainIds ?? []).map((id: number, i: number) => {
          const c = store.getChain(id);
          if (!c) throw new ChainError(`链 ${id} 不存在`, `chainIds[${i}]`);
          return c;
        });
        const states = (b.stateIds ?? []).map((id: number, i: number) => {
          const s = store.getState(id);
          if (!s) throw new ChainError(`状态 ${id} 不存在`, `stateIds[${i}]`);
          return s;
        });
        if (!chains.length && !states.length) throw new ChainError("缺少 chainIds 或 stateIds", "body");
        return send(200, { chains, states });
      }
      if (m === "GET" && seg[1] === "export") {
        const fmt = url.searchParams.get("format") ?? "json";
        const data = { states: store.listStates().map((s: any) => ({ ...s, ...(store.getState(s.id) ?? {}) })), chains: store.listChains().map((c: any) => store.getChain(c.id)) };
        if (fmt === "csv") {
          const rows: any[] = [];
          for (const s of data.states) {
            const r: any = s.result ?? {};
            const o = r.outlet ?? r;
            rows.push({ id: s.id, label: s.label, T: o.T, W: o.W, rh: o.rh, h: o.h, Tdp: o.Tdp, v: o.v, p: o.p });
          }
          return send(200, toCsv(rows, ["id", "label", "T", "W", "rh", "h", "Tdp", "v", "p"]), true);
        }
        return send(200, data);
      }
      if (m === "POST" && seg[1] === "import") {
        const b = await readBody(req);
        let nStates = 0, nChains = 0;
        for (const s of b.states ?? []) { store.saveState(s.label ?? "imported", s.inputs, s.result); nStates++; }
        for (const c of b.chains ?? []) {
          const cid = store.createChain(`${c.name ?? "imported"}(import)`);
          for (const st of c.steps ?? []) store.addStep(cid, st.seq, st.name, st.kind, st.inputs, st.output, st.balances);
          nChains++;
        }
        return send(200, { importedStates: nStates, importedChains: nChains });
      }
      return send(404, errBody("NOT_FOUND", "未知路径", url.pathname));
    } catch (e: any) {
      if (e instanceof ChainError || e instanceof PsychroError)
        return send(400, errBody("BAD_INPUT", e.message, (e as any).node ?? (e as any).path));
      return send(500, errBody("INTERNAL", e?.message ?? String(e)));
    }
  });
  return server;
}

if (require.main === module) {
  const config = loadConfig();
  const store = new Store(path.join(config.dataDir, "psychro.db"));
  const server = createServer(store, config);
  server.listen(config.port, () => {
    console.log(`湿空气计算服务已启动: http://localhost:${config.port}  数据目录: ${config.dataDir}`);
  });
}
