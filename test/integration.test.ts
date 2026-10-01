import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Store } from "../src/store";
import { createServer } from "../src/api";
import { executeChain, Step } from "../src/engine";
import { parseImport, exportCsv } from "../src/importExport";
import { Server } from "node:http";

const STEPS: Step[] = [
  { id: "oa", type: "state", input: { p: 101.325, t: 34, rh: 0.65 } },
  { id: "ra", type: "state", input: { p: 101.325, t: 26, rh: 0.55 } },
  { id: "ma", type: "mix", p: 101.325, streams: [{ from: "oa", mDa: 0.4 }, { from: "ra", mDa: 1.1 }] },
  { id: "cc", type: "coil", from: "ma", mDa: 1.5, tSurface: 8, bypassFactor: 0.1 },
];

test("存储：编辑上游状态产生新版本，旧版本仍可查询", () => {
  const store = new Store(":memory:");
  const v1 = executeChain(STEPS);
  const r1 = store.saveChainExecution("ahu", v1);
  assert.equal(r1.version, 1);

  // 编辑上游室外状态后重新执行
  const steps2 = STEPS.map((s) =>
    s.id === "oa" ? { ...s, input: { p: 101.325, t: 30, rh: 0.6 } } : s,
  ) as Step[];
  const v2 = executeChain(steps2);
  const r2 = store.saveChainExecution("ahu", v2);
  assert.equal(r2.version, 2);

  const old = store.getChain(r1.chainId, 1)!;
  const latest = store.getChain(r1.chainId)!;
  assert.equal(old.version, 1);
  assert.equal(latest.version, 2);
  const oldOa = (old.steps as { id: string; state?: { t: number } }[]).find((s) => s.id === "oa")!;
  assert.ok(Math.abs(oldOa.state!.t - 34) < 1e-9, "旧版本应保留原始输入的结果");
  assert.equal(store.listChains().length, 1);
  assert.ok(store.listParamVersions().length >= 1);
  store.close();
});

test("导入导出：CSV 解析与列校验", () => {
  const rows = parseImport("csv", "p,t,rh\n101.325,25,0.5\n100,30,0.6\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].rh, 0.5);
  const csv = exportCsv([{ a: 1, b: "x,y" }]);
  assert.ok(csv.includes('"x,y"'));
  assert.throws(() => parseImport("csv", "p,t\n1,2,3\n"), /列数/);
  assert.throws(() => parseImport("xml", "<a/>"), /不支持/);
});

let server: Server;
let base: string;

before(async () => {
  server = createServer(new Store(":memory:"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("API：单状态求解", async () => {
  const { status, json } = await post("/api/state", { p: 101.325, t: 25, rh: 0.5 });
  assert.equal(status, 200);
  const s = json.state as { w: number; h: number };
  assert.ok(Math.abs(s.w - 0.00988) < 5e-5);
});

test("API：错误带节点定位", async () => {
  const { status, json } = await post("/api/state", { p: 101.325, t: 25, rh: 2 });
  assert.equal(status, 400);
  const err = json.error as { code: string; node: string };
  assert.equal(err.code, "INVALID_INPUT");
  assert.equal(err.node, "state");
});

test("API：过程链执行与查询", async () => {
  const { status, json } = await post("/api/chains", { name: "api-chain", steps: STEPS });
  assert.equal(status, 200);
  const chainId = json.chainId as number;
  const res = await fetch(`${base}/api/chains/${chainId}`);
  assert.equal(res.status, 200);
  const chain = (await res.json()) as { steps: { id: string }[] };
  assert.equal(chain.steps.length, 4);
  const missing = await fetch(`${base}/api/chains/9999`);
  assert.equal(missing.status, 404);
});

test("API：盘管比较", async () => {
  const { status, json } = await post("/api/compare", {
    state: { p: 101.325, t: 32, rh: 0.6 },
    mDa: 1.5,
    cases: [
      { tSurface: 8, bypassFactor: 0.1 },
      { tSurface: 6, bypassFactor: 0.05 },
    ],
  });
  assert.equal(status, 200);
  const results = json.results as { q: number; condensate: number }[];
  assert.equal(results.length, 2);
  assert.ok(results[1].q > results[0].q, "更低表面温度与旁通因子应有更大冷负荷");
});
