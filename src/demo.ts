// 固定算例演示：室内状态、等状态混风、显热升温、结露冷却、盘管参数比较。
// 结果写入 SQLite，服务重启后可通过 chain get / API 重新读取。
import { solveState } from "./psychro";
import { coolingCoil, mix, sensible } from "./processes";
import { executeChain, Step } from "./engine";
import { Store } from "./store";

function fmt(s: ReturnType<typeof solveState>): string {
  return (
    `t=${s.t.toFixed(2)}C W=${(s.w * 1000).toFixed(3)}g/kg RH=${(s.rh * 100).toFixed(1)}% ` +
    `h=${s.h.toFixed(2)}kJ/kg tdp=${s.tdp.toFixed(2)}C`
  );
}

export function runDemo(dbPath: string): void {
  const store = new Store(dbPath);
  const p = 101.325;
  console.log("=== 湿空气计算演示（每 kg 干空气基准） ===");

  console.log("[1] 室内状态点（t=26C, RH=55%）");
  const indoor = solveState({ p, t: 26, rh: 0.55 });
  console.log(`    ${fmt(indoor)}`);

  console.log("[2] 等状态混风（两股相同状态 1.0 + 2.0 kg/s，结果应与进风一致）");
  const m1 = mix(
    [
      { state: indoor, mDa: 1.0 },
      { state: indoor, mDa: 2.0 },
    ],
    p,
  );
  console.log(`    混风: ${fmt(m1.state)}`);

  console.log("[3] 显热升温（26C -> 35C, 1.2 kg/s，含湿量不变）");
  const sh = sensible({ state: indoor, mDa: 1.2 }, 35);
  console.log(`    出风: ${fmt(sh.state)}  Q=${sh.q.toFixed(3)} kW`);

  console.log("[4] 结露冷却盘管（进风 32C/60%, ts=8C, BF=0.10, 1.5 kg/s）");
  const hot = solveState({ p, t: 32, rh: 0.6 });
  const coilA = coolingCoil({ state: hot, mDa: 1.5 }, 8, 0.1);
  console.log(`    出风: ${fmt(coilA.state)}`);
  console.log(`    Q=${coilA.q.toFixed(3)} kW, 凝结水=${(coilA.condensate * 1000).toFixed(2)} g/s`);

  console.log("[5] 盘管参数比较（同一进风）");
  const coilB = coolingCoil({ state: hot, mDa: 1.5 }, 6, 0.05);
  console.log(`    工况A ts=8C  BF=0.10: 出风 ${fmt(coilA.state)}  Q=${coilA.q.toFixed(3)} kW  凝结水=${(coilA.condensate * 1000).toFixed(2)} g/s`);
  console.log(`    工况B ts=6C  BF=0.05: 出风 ${fmt(coilB.state)}  Q=${coilB.q.toFixed(3)} kW  凝结水=${(coilB.condensate * 1000).toFixed(2)} g/s`);

  console.log("[6] 过程链：室外新风 + 回风混风 -> 冷却盘管 -> 再热");
  const steps: Step[] = [
    { id: "oa", type: "state", input: { p, t: 34, rh: 0.65 } },
    { id: "ra", type: "state", input: { p, t: 26, rh: 0.55 } },
    { id: "ma", type: "mix", p, streams: [{ from: "oa", mDa: 0.4 }, { from: "ra", mDa: 1.1 }] },
    { id: "cc", type: "coil", from: "ma", mDa: 1.5, tSurface: 8, bypassFactor: 0.1 },
    { id: "sa", type: "sensible", from: "cc", mDa: 1.5, tOut: 20 },
  ];
  const records = executeChain(steps);
  const { chainId, version } = store.saveChainExecution("demo-ahu", records);
  for (const r of records) {
    if (r.state) console.log(`    [${r.id}] ${r.type}: ${fmt(r.state)}`);
    if (r.q !== undefined) {
      console.log(`         Q=${r.q.toFixed(3)} kW` + (r.condensate ? `  凝结水=${(r.condensate * 1000).toFixed(2)} g/s` : ""));
    }
  }
  console.log(`    已保存过程链 chainId=${chainId} version=${version}`);
  console.log("    重新读取校验: " + (store.getChain(chainId) ? "OK（重启后仍可查询）" : "失败"));
  store.close();
}

if (require.main === module) {
  runDemo(process.argv[2] ?? "data/psychro.db");
}
