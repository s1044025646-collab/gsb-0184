/**
 * 演示：四个固定算例 + 两个盘管参数对比 + 持久化验证（关库重开读取）。
 * 运行: npm run demo
 */
import * as path from "node:path";
import { solveState } from "./psychro";
import { coolingCoil, mixStreams, sensibleToTemperature } from "./processes";
import { runAndSaveChain } from "./chain";
import { Store } from "./store";
import { loadConfig } from "./api";

const P = 101.325;

function line(label: string, s: any): void {
  const o = s.outlet ?? s;
  console.log(
    `  ${label}: T=${o.T.toFixed(2)}°C W=${(o.W * 1000).toFixed(3)}g/kg RH=${(o.rh * 100).toFixed(1)}% ` +
    `h=${o.h.toFixed(2)}kJ/kg Tdp=${o.Tdp == null ? "N/A" : o.Tdp.toFixed(2) + "°C"}`
  );
}

function main(): void {
  const config = loadConfig();
  const dbPath = path.join(config.dataDir, "psychro.db");
  const store = new Store(dbPath);
  console.log(`数据库: ${dbPath}\n`);

  console.log("== 算例1 室内状态点（26°C, RH 60%）==");
  const room = solveState(P, { T: 26, rh: 0.6 });
  line("室内", room);

  console.log("\n== 算例2 等状态混风（两股相同状态 1 kg/s + 2 kg/s）==");
  const mixSame = mixStreams([
    { state: { T: 26, rh: 0.6 }, mda: 1 },
    { state: { T: 26, rh: 0.6 }, mda: 2 },
  ], P);
  line("混风出口", mixSame.outlet);
  console.log(`  水分残差=${mixSame.balances.waterResidual.toExponential(2)} 能量残差=${mixSame.balances.energyResidual.toExponential(2)}`);

  console.log("\n== 算例3 显热升温（26°C -> 35°C, 1.2 kg/s）==");
  const heat = sensibleToTemperature({ T: 26, rh: 0.6 }, 1.2, 35, P);
  line("出风", heat.outlet);
  console.log(`  显热负荷 Q=${heat.Q.toFixed(3)} kW`);

  console.log("\n== 算例4 结露冷却（30°C/70% -> Ts=8°C, BF=0.10, 1.2 kg/s）==");
  const coilA = coolingCoil({ T: 30, rh: 0.7 }, 1.2, 8, 0.10, P);
  line("出风", coilA.outlet);
  console.log(`  凝结水=${(coilA.condensate * 3600).toFixed(3)} kg/h  热负荷=${coilA.Q.toFixed(3)} kW`);

  console.log("\n== 盘管参数对比：BF=0.10 vs BF=0.25（同 Ts=8°C）==");
  const coilB = coolingCoil({ T: 30, rh: 0.7 }, 1.2, 8, 0.25, P);
  line("BF=0.10", coilA.outlet);
  line("BF=0.25", coilB.outlet);
  console.log(`  凝结水: ${(coilA.condensate * 3600).toFixed(3)} vs ${(coilB.condensate * 3600).toFixed(3)} kg/h`);
  console.log(`  热负荷: ${coilA.Q.toFixed(3)} vs ${coilB.Q.toFixed(3)} kW`);

  console.log("\n== 过程链持久化（新风+回风混风 -> 盘管除湿）==");
  const steps = [
    { id: "oa", type: "state", state: { T: 34, rh: 0.65 } },
    { id: "ra", type: "state", state: { T: 26, rh: 0.6 } },
    { id: "mix", type: "mix", streams: [{ from: "oa", mda: 0.3 }, { from: "ra", mda: 0.9 }] },
    { id: "coilA", type: "coil", from: "mix", mda: 1.2, Ts: 8, BF: 0.10 },
  ];
  const r1 = runAndSaveChain(store, "demo-夏季工况-BF0.10", steps as any, P);
  const r2 = runAndSaveChain(store, "demo-夏季工况-BF0.25", steps.map((s: any) => s.id === "coilA" ? { ...s, BF: 0.25 } : s) as any, P);
  console.log(`  已保存链 #${r1.chainId} 与 #${r2.chainId}`);
  for (const r of [r1, r2]) {
    const coilStep: any = r.executed.find((s) => s.id === "coilA")!.output;
    console.log(`  链#${r.chainId}: 出风 T=${coilStep.outlet.T.toFixed(2)}°C W=${(coilStep.outlet.W * 1000).toFixed(3)}g/kg 凝结水=${(coilStep.condensate * 3600).toFixed(3)}kg/h 负荷=${coilStep.Q.toFixed(3)}kW`);
  }

  console.log("\n== 持久化验证：关闭数据库并重新打开读取 ==");
  store.close();
  const store2 = new Store(dbPath);
  const back = store2.getChain(r1.chainId);
  console.log(`  重开后读取链 #${back!.id} "${back!.name}"，共 ${back!.steps.length} 步，首步输出 T=${(back!.steps[0].output as any).T.toFixed(2)}°C`);
  store2.close();
  console.log("\n演示完成。");
}

main();
