// 命令行入口：state / mix / coil / chain / compare / import / export / demo / serve。
import * as fs from "node:fs";
import { solveState, StateInput, RANGE } from "./psychro";
import { coolingCoil, mix, sensible } from "./processes";
import { executeChain, Step } from "./engine";
import { Store } from "./store";
import { parseImport, exportCsv, exportJson } from "./importExport";
import { startServer } from "./api";
import { runDemo } from "./demo";

const DEFAULT_DB = "data/psychro.db";
const DEFAULT_PORT = 8137;

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string>; positional: string[] } {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

function num(flags: Record<string, string>, key: string, required = true): number | undefined {
  const v = flags[key];
  if (v === undefined) {
    if (required) throw new Error(`缺少参数 --${key}`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`参数 --${key} 不是数值: ${v}`);
  return n;
}

function stateInputFromFlags(flags: Record<string, string>): StateInput {
  const p = num(flags, "p")!;
  const t = num(flags, "t")!;
  if (flags.rh !== undefined) return { p, t, rh: num(flags, "rh")! };
  if (flags.w !== undefined) return { p, t, w: num(flags, "w")! };
  if (flags.tdp !== undefined) return { p, t, tdp: num(flags, "tdp")! };
  throw new Error("需要 --rh、--w 或 --tdp 之一作为第二参数");
}

function printState(label: string, s: ReturnType<typeof solveState>): void {
  console.log(
    `${label}: t=${s.t.toFixed(2)}C  W=${(s.w * 1000).toFixed(3)} g/kg(da)  RH=${(s.rh * 100).toFixed(1)}%  ` +
      `h=${s.h.toFixed(2)} kJ/kg(da)  tdp=${s.tdp.toFixed(2)}C  pw=${s.pw.toFixed(4)} kPa  v=${s.v.toFixed(4)} m3/kg(da)`,
  );
}

const HELP = [
  "湿空气计算 CLI（温度 C，压力 kPa，流量 kg干空气/s，负荷 kW，适用范围 0-60C / 80-115 kPa）",
  "",
  "用法：",
  "  state    --p 101.325 --t 25 (--rh 0.5 | --w 0.01 | --tdp 14)",
  "  mix      --p 101.325 --streams <json>",
  "  coil     --p 101.325 --t 32 --rh 0.6 --m 1.5 --ts 8 --bf 0.1",
  "  sensible --p 101.325 --t 20 --rh 0.5 --m 1 --tout 35",
  "  chain run <file.json> [--name 名称]   执行并保存过程链（同名链产生新版本快照）",
  "  chain get <chainId> [--version N]",
  "  chain list",
  "  compare  --p 101.325 --t 32 --rh 0.6 --m 1.5 --cases <json>",
  "  import   --format csv --file states.csv",
  "  export   [--chainId 1] [--format json|csv]",
  "  demo     运行固定算例演示",
  "  serve    [--port 8137] [--db data/psychro.db]",
  "通用：--db 指定数据库文件",
  "",
].join("\n");

export function runCli(argv: string[], dbPath?: string): void {
  const { cmd, flags, positional } = parseArgs(argv);
  const db = flags.db ?? dbPath ?? DEFAULT_DB;

  switch (cmd) {
    case "help":
      console.log(HELP);
      return;
    case "serve": {
      startServer(Number(flags.port ?? DEFAULT_PORT), db);
      return;
    }
    case "demo": {
      runDemo(db);
      return;
    }
    case "state": {
      const store = new Store(db);
      const input = stateInputFromFlags(flags);
      const s = solveState(input);
      const id = store.saveState(input, s);
      printState(`状态点 #${id}`, s);
      store.close();
      return;
    }
    case "mix": {
      const store = new Store(db);
      const p = num(flags, "p")!;
      const streams = JSON.parse(flags.streams ?? "[]") as { state: StateInput; mDa: number }[];
      const solved = streams.map((s, i) => ({ state: solveState(s.state, `streams[${i}]`), mDa: s.mDa }));
      const r = mix(solved, p);
      const id = store.saveState({ p, streams }, r);
      printState(`混风结果 #${id}`, r.state);
      console.log(`  守恒校验: 干空气 ${r.balance.mDaIn.toFixed(4)} -> ${r.balance.mDaOut.toFixed(4)} kg/s`);
      store.close();
      return;
    }
    case "coil": {
      const store = new Store(db);
      const sIn = solveState(stateInputFromFlags(flags));
      const r = coolingCoil({ state: sIn, mDa: num(flags, "m")! }, num(flags, "ts")!, num(flags, "bf")!);
      const id = store.saveState(flags, r);
      printState("进风", sIn);
      printState(`出风 #${id}`, r.state);
      console.log(`  冷负荷 Q=${r.q.toFixed(3)} kW (显热 ${r.sensibleQ.toFixed(3)} + 潜热 ${r.latentQ.toFixed(3)}), 凝结水 ${(r.condensate * 1000).toFixed(2)} g/s`);
      store.close();
      return;
    }
    case "sensible": {
      const store = new Store(db);
      const sIn = solveState(stateInputFromFlags(flags));
      const r = sensible({ state: sIn, mDa: num(flags, "m")! }, num(flags, "tout")!);
      const id = store.saveState(flags, r);
      printState("进风", sIn);
      printState(`出风 #${id}`, r.state);
      console.log(`  显热负荷 Q=${r.q.toFixed(3)} kW`);
      store.close();
      return;
    }
    case "compare": {
      const sIn = solveState(stateInputFromFlags(flags));
      const mDa = num(flags, "m")!;
      const cases = JSON.parse(flags.cases ?? "[]") as { name?: string; tSurface: number; bypassFactor: number }[];
      printState("进风", sIn);
      for (const [i, c] of cases.entries()) {
        const r = coolingCoil({ state: sIn, mDa }, c.tSurface, c.bypassFactor, `cases[${i}]`);
        console.log(`工况 ${c.name ?? i + 1} (ts=${c.tSurface}C, BF=${c.bypassFactor}):`);
        printState("  出风", r.state);
        console.log(`    Q=${r.q.toFixed(3)} kW, 凝结水 ${(r.condensate * 1000).toFixed(2)} g/s`);
      }
      return;
    }
    case "chain": {
      const store = new Store(db);
      const sub = positional[0];
      if (sub === "run") {
        const file = positional[1];
        if (!file) throw new Error("用法: chain run <file.json> [--name 名称]");
        const def = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; steps: Step[] };
        const records = executeChain(def.steps);
        const name = flags.name ?? def.name ?? `chain-${Date.now()}`;
        const { chainId, version } = store.saveChainExecution(name, records);
        console.log(`过程链 "${name}" 已执行并保存: chainId=${chainId}, version=${version}`);
        for (const r of records) {
          if (r.state) printState(`  [${r.id}] (${r.type})`, r.state);
          if (r.q !== undefined) {
            console.log(`    Q=${r.q.toFixed(3)} kW` + (r.condensate ? `, 凝结水 ${(r.condensate * 1000).toFixed(2)} g/s` : ""));
          }
        }
      } else if (sub === "get") {
        const chain = store.getChain(Number(positional[1]), flags.version ? Number(flags.version) : undefined);
        if (!chain) throw new Error(`过程链 ${positional[1]} 不存在`);
        console.log(JSON.stringify(chain, null, 2));
      } else if (sub === "list") {
        console.log(JSON.stringify(store.listChains(), null, 2));
      } else {
        throw new Error("chain 子命令: run | get | list");
      }
      store.close();
      return;
    }
    case "import": {
      const store = new Store(db);
      const content = fs.readFileSync(flags.file ?? "", "utf8");
      const items = parseImport(flags.format ?? "json", content);
      for (const item of items) {
        const s = solveState(item as unknown as StateInput, "import");
        const id = store.saveState(item, s);
        printState(`导入状态 #${id}`, s);
      }
      store.close();
      return;
    }
    case "export": {
      const store = new Store(db);
      if (flags.chainid) {
        const chain = store.getChain(Number(flags.chainid));
        if (!chain) throw new Error(`过程链 ${flags.chainid} 不存在`);
        const out = flags.format === "csv" ? exportCsv(chain.steps as Record<string, unknown>[]) : exportJson(chain);
        console.log(out);
      } else {
        console.log(exportJson({ chains: store.listChains() }));
      }
      store.close();
      return;
    }
    default:
      console.error(`未知命令 "${cmd}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (e) {
    const err = e as { code?: string; message?: string; node?: string };
    console.error(`错误${err.code ? ` [${err.code}]` : ""}${err.node ? ` @ ${err.node}` : ""}: ${err.message}`);
    process.exitCode = 1;
  }
}
