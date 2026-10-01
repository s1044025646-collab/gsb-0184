/**
 * CLI：state / mix / coil / heat / chain / chains / snapshot / compare / export / import
 * 用法示例见 README。所有 JSON 参数用单引号包裹（PowerShell 中用 '' 转义）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { solveState } from "./psychro";
import { coolingCoil, mixStreams, sensibleToTemperature } from "./processes";
import { runAndSaveChain, snapshotChain } from "./chain";
import { Store } from "./store";
import { loadConfig } from "./api";

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) opts[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
  }
  return { cmd, opts };
}

const J = (s: string | undefined, what: string) => {
  if (!s) throw new Error(`缺少参数 --${what}（JSON）`);
  return JSON.parse(s);
};

function printState(label: string, s: any): void {
  const o = s.outlet ?? s;
  console.log(
    `${label}: T=${o.T.toFixed(2)}°C  W=${(o.W * 1000).toFixed(3)} g/kg_da  RH=${(o.rh * 100).toFixed(1)}%  ` +
    `h=${o.h.toFixed(2)} kJ/kg_da  Tdp=${o.Tdp == null ? "N/A" : o.Tdp.toFixed(2) + "°C"}  pw=${o.pw.toFixed(4)} kPa  v=${o.v.toFixed(4)} m3/kg_da`
  );
}

function main(): void {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(path.join(config.dataDir, "psychro.db"));
  const p = opts.p ? Number(opts.p) : 101.325;
  try {
    switch (cmd) {
      case "state": {
        const out = solveState(p, J(opts.state, "state"), "state");
        const id = opts.save ? store.saveState(opts.label ?? "cli-state", { p, state: JSON.parse(opts.state) }, out) : null;
        printState(`状态${id ? " #" + id : ""}`, out);
        break;
      }
      case "mix": {
        const out = mixStreams(J(opts.streams, "streams"), p);
        printState("混风出口", out.outlet);
        console.log(`水分核算残差=${out.balances.waterResidual.toExponential(2)} kg/s, 能量核算残差=${out.balances.energyResidual.toExponential(2)} kW`);
        break;
      }
      case "coil": {
        const out = coolingCoil(J(opts.inlet, "inlet"), Number(opts.mda), Number(opts.Ts), Number(opts.BF), p);
        printState("盘管出风", out.outlet);
        console.log(`凝露=${out.condensing ? "是" : "否"}  凝结水=${(out.condensate * 3600).toFixed(3)} kg/h  热负荷=${out.Q.toFixed(3)} kW`);
        break;
      }
      case "heat": {
        const out = sensibleToTemperature(J(opts.inlet, "inlet"), Number(opts.mda), Number(opts.Tout), p);
        printState("加热出风", out.outlet);
        console.log(`显热负荷=${out.Q.toFixed(3)} kW`);
        break;
      }
      case "chain": {
        const def = opts.file ? JSON.parse(fs.readFileSync(opts.file, "utf8")) : J(opts.def, "def");
        const r = runAndSaveChain(store, def.name ?? "cli-chain", def.steps, def.p ?? p);
        console.log(`链已执行并保存: chainId=${r.chainId}`);
        r.executed.forEach((st) => {
          const o: any = st.output;
          printState(`  [${st.id}] ${st.type}`, o.outlet ?? o);
          if (o.condensate != null) console.log(`    凝结水=${(o.condensate * 3600).toFixed(3)} kg/h  热负荷=${o.Q.toFixed(3)} kW`);
        });
        break;
      }
      case "chains": console.log(JSON.stringify(store.listChains(), null, 2)); break;
      case "chain-get": {
        const c = store.getChain(Number(opts.id));
        if (!c) throw new Error(`链 ${opts.id} 不存在`);
        console.log(JSON.stringify(c, null, 2));
        break;
      }
      case "snapshot": {
        const r = snapshotChain(store, Number(opts.id), J(opts.overrides, "overrides"), p, opts.name);
        console.log(`新快照链 chainId=${r.chainId}（源链 ${opts.id} 保持不变）`);
        break;
      }
      case "compare": {
        const ids = J(opts.chainIds, "chainIds") as number[];
        for (const id of ids) {
          const c = store.getChain(id);
          if (!c) throw new Error(`链 ${id} 不存在`);
          console.log(`链 #${c.id} "${c.name}" (${c.created_at})`);
          for (const st of c.steps) {
            const o: any = st.output;
            printState(`  [${st.name}] ${st.kind}`, o.outlet ?? o);
            if (o.condensate != null) console.log(`    凝结水=${(o.condensate * 3600).toFixed(3)} kg/h  热负荷=${o.Q.toFixed(3)} kW`);
          }
        }
        break;
      }
      case "export": {
        const data = { states: store.listStates().map((s: any) => store.getState(s.id)), chains: store.listChains().map((c: any) => store.getChain(c.id)) };
        if (opts.format === "csv") {
          const rows = data.states.map((s: any) => {
            const o = s.result.outlet ?? s.result;
            return [s.id, s.label, o.T, o.W, o.rh, o.h, o.Tdp, o.v, o.p].join(",");
          });
          const csv = "id,label,T,W,rh,h,Tdp,v,p\r\n" + rows.join("\r\n");
          opts.out ? fs.writeFileSync(opts.out, csv) : console.log(csv);
        } else {
          const json = JSON.stringify(data, null, 2);
          opts.out ? fs.writeFileSync(opts.out, json) : console.log(json);
        }
        break;
      }
      case "import": {
        const b = JSON.parse(fs.readFileSync(J(opts.file, "file"), "utf8"));
        let n = 0;
        for (const s of b.states ?? []) { store.saveState(s.label ?? "imported", s.inputs, s.result); n++; }
        for (const c of b.chains ?? []) {
          const cid = store.createChain(`${c.name}(import)`);
          for (const st of c.steps ?? []) store.addStep(cid, st.seq, st.name, st.kind, st.inputs, st.output, st.balances);
          n++;
        }
        console.log(`导入完成，共 ${n} 条记录`);
        break;
      }
      default:
        console.log(`命令: state | mix | coil | heat | chain | chains | chain-get | snapshot | compare | export | import
示例:
  state --state "{\\"T\\":25,\\"rh\\":0.6}"
  mix --streams "[{\\"state\\":{\\"T\\":30,\\"rh\\":0.7},\\"mda\\":1},{\\"state\\":{\\"T\\":20,\\"rh\\":0.5},\\"mda\\":2}]"
  coil --inlet "{\\"T\\":30,\\"rh\\":0.7}" --mda 1.2 --Ts 8 --BF 0.1
  chain --file examples/chain1.json
  compare --chainIds "[1,2]"`);
    }
  } finally {
    store.close();
  }
}

try { main(); } catch (e: any) {
  const node = e.node ?? e.path;
  console.error(`错误${node ? " [" + node + "]" : ""}: ${e.message}`);
  process.exit(1);
}
