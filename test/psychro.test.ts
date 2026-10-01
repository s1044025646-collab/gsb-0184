import { test } from "node:test";
import assert from "node:assert/strict";
import { dewpointFromVaporPressure, satVaporPressurePa, solveState, stateFromHW } from "../src/psychro";
import { coolingCoil, mixStreams, sensibleToTemperature } from "../src/processes";
import { runChain } from "../src/chain";

const P = 101.325;

// ---- 独立参考值（ASHRAE Handbook 公布值，非本程序输出）----
test("饱和蒸气压参考值：20°C=2338.8Pa, 25°C=3169.9Pa, 0.01°C=611.657Pa(三相点)", () => {
  assert.ok(Math.abs(satVaporPressurePa(20) - 2338.8) < 1.0);
  assert.ok(Math.abs(satVaporPressurePa(25) - 3169.9) < 1.5);
  assert.ok(Math.abs(satVaporPressurePa(0.01) - 611.657) < 0.5);
});

test("标准状态点 25°C/RH50%: W≈9.88 g/kg, h≈50.29 kJ/kg（ASHRAE  sea level）", () => {
  const s = solveState(P, { T: 25, rh: 0.5 });
  assert.ok(Math.abs(s.W - 0.00988) < 5e-5, `W=${s.W}`);
  assert.ok(Math.abs(s.h - 50.29) < 0.1, `h=${s.h}`);
  assert.ok(Math.abs(s.pw - 1.585) < 0.01);
  assert.ok(Math.abs(s.Tdp! - 13.9) < 0.2, `Tdp=${s.Tdp}`);
});

test("三种输入形式转换一致：T+rh / T+W / T+Tdp 给出同一状态", () => {
  const a = solveState(P, { T: 30, rh: 0.55 });
  const b = solveState(P, { T: 30, W: a.W });
  const c = solveState(P, { T: 30, Tdp: a.Tdp! });
  for (const k of ["W", "h", "pw", "rh"] as const) {
    assert.ok(Math.abs(a[k] - b[k]) < 1e-9, k);
    assert.ok(Math.abs(a[k] - c[k]) < 1e-6, k);
  }
});

test("露点-饱和压互逆", () => {
  for (const T of [0, 10, 25, 40, 55]) {
    const p = satVaporPressurePa(T);
    assert.ok(Math.abs(dewpointFromVaporPressure(p) - T) < 1e-6);
  }
});

test("零湿度边界：W=0 不报错，露点为 null，焓=1.006T", () => {
  const s = solveState(P, { T: 40, W: 0 });
  assert.equal(s.W, 0);
  assert.equal(s.Tdp, null);
  assert.ok(Math.abs(s.h - 1.006 * 40) < 1e-12);
  assert.equal(s.rh, 0);
});

test("露点恒不高于干球温度（全范围扫描）", () => {
  for (let T = 0; T <= 60; T += 5) {
    for (const rh of [0.05, 0.3, 0.7, 1.0]) {
      const s = solveState(P, { T, rh });
      assert.ok(s.Tdp! <= T + 1e-9, `T=${T} rh=${rh} Tdp=${s.Tdp}`);
    }
  }
});

test("超范围输入被拒绝", () => {
  assert.throws(() => solveState(P, { T: 70, rh: 0.5 }), /超出适用范围/);
  assert.throws(() => solveState(70, { T: 25, rh: 0.5 }), /超出适用范围/);
  assert.throws(() => solveState(P, { T: 25, rh: 1.2 }), /相对湿度/);
  assert.throws(() => solveState(P, { T: 25, W: -0.001 }), /含湿量/);
  assert.throws(() => solveState(P, { T: 25, Tdp: 30 }), /露点/);
});

// ---- 混风 ----
test("混风水分与焓独立守恒断言", () => {
  const s1 = solveState(P, { T: 34, rh: 0.7 });
  const s2 = solveState(P, { T: 22, rh: 0.5 });
  const r = mixStreams([{ state: { T: 34, rh: 0.7 }, mda: 0.4 }, { state: { T: 22, rh: 0.5 }, mda: 1.1 }], P);
  // 独立守恒式（不依赖本程序的混合实现）
  const Wexp = (0.4 * s1.W + 1.1 * s2.W) / 1.5;
  const hexp = (0.4 * s1.h + 1.1 * s2.h) / 1.5;
  assert.ok(Math.abs(r.outlet.W - Wexp) < 1e-12);
  assert.ok(Math.abs(r.outlet.h - hexp) < 1e-9);
  assert.ok(Math.abs(r.balances.waterResidual) < 1e-12);
  assert.ok(Math.abs(r.balances.energyResidual) < 1e-9);
});

test("等状态混风结果等于原状态", () => {
  const r = mixStreams([{ state: { T: 26, rh: 0.6 }, mda: 1 }, { state: { T: 26, rh: 0.6 }, mda: 2 }], P);
  assert.ok(Math.abs(r.outlet.T - 26) < 1e-9);
  assert.ok(Math.abs(r.outlet.rh - 0.6) < 1e-9);
});

test("混风超饱和被明确拒绝（两股近饱和冷空气）", () => {
  assert.throws(
    () => mixStreams([{ state: { T: 5, rh: 1.0 }, mda: 1 }, { state: { T: 25, rh: 1.0 }, mda: 1 }], P),
    /超饱和/
  );
});

test("负流量与零流量被拒绝", () => {
  assert.throws(() => mixStreams([{ state: { T: 25, rh: 0.5 }, mda: -1 }, { state: { T: 25, rh: 0.5 }, mda: 1 }], P), /流量/);
  assert.throws(() => mixStreams([{ state: { T: 25, rh: 0.5 }, mda: 0 }, { state: { T: 25, rh: 0.5 }, mda: 1 }], P), /流量/);
});

// ---- 显热 ----
test("显热加热：W 不变，Q = m*cpa*ΔT 独立核对", () => {
  const r = sensibleToTemperature({ T: 20, rh: 0.5 }, 1.5, 35, P);
  const s1 = solveState(P, { T: 20, rh: 0.5 });
  assert.ok(Math.abs(r.outlet.W - s1.W) < 1e-12);
  // 独立比热核算：Q ≈ m*(1.006+1.86W)*ΔT
  const Qexp = 1.5 * (1.006 + 1.86 * s1.W) * 15;
  assert.ok(Math.abs(r.Q - Qexp) < 1e-9, `Q=${r.Q} vs ${Qexp}`);
});

// ---- 盘管 ----
test("旁通因子极限：BF=0 出风为表面温度饱和态；BF=1 出风=进风", () => {
  const inlet = { T: 30, rh: 0.7 };
  const r0 = coolingCoil(inlet, 1.0, 8, 0, P);
  assert.ok(Math.abs(r0.outlet.T - 8) < 1e-9);
  assert.ok(Math.abs(r0.outlet.rh - 1) < 1e-6);
  const r1 = coolingCoil(inlet, 1.0, 8, 1, P);
  const s1 = solveState(P, inlet);
  assert.ok(Math.abs(r1.outlet.T - s1.T) < 1e-9);
  assert.ok(Math.abs(r1.outlet.W - s1.W) < 1e-12);
  assert.equal(r1.condensate, 0);
});

test("无凝露冷却：Ts 高于露点时凝结水为 0，W 不变", () => {
  const s1 = solveState(P, { T: 25, rh: 0.4 }); // Tdp≈10.3
  const r = coolingCoil({ T: 25, rh: 0.4 }, 2.0, 15, 0.2, P);
  assert.equal(r.condensing, false);
  assert.equal(r.condensate, 0);
  assert.ok(Math.abs(r.outlet.W - s1.W) < 1e-12);
  assert.ok(Math.abs(r.outlet.T - (15 + (25 - 15) * 0.2)) < 1e-9);
});

test("结露冷却：水分与能量独立守恒断言", () => {
  const mda = 1.2;
  const s1 = solveState(P, { T: 30, rh: 0.7 });
  const r = coolingCoil({ T: 30, rh: 0.7 }, mda, 8, 0.1, P);
  assert.ok(r.condensing);
  // 水分守恒：凝结水 = m*(W1-W2)
  assert.ok(Math.abs(r.condensate - mda * (s1.W - r.outlet.W)) < 1e-12);
  assert.ok(Math.abs(r.balances.waterResidual) < 1e-12);
  // 能量守恒：Q = m*(h1-h2)
  assert.ok(Math.abs(r.Q - mda * (s1.h - r.outlet.h)) < 1e-9);
  assert.ok(Math.abs(r.balances.energyResidual) < 1e-9);
  // 出风在进风与饱和线之间
  assert.ok(r.outlet.T > 8 && r.outlet.T < 30);
  assert.ok(r.outlet.W < s1.W);
});

test("BF 越界被拒绝", () => {
  assert.throws(() => coolingCoil({ T: 30, rh: 0.7 }, 1, 8, 1.5, P), /旁通因子/);
});

// ---- 过程链 ----
test("循环引用与自引用被拒绝", () => {
  assert.throws(() => runChain([
    { id: "a", type: "state", state: { T: 25, rh: 0.5 } },
    { id: "b", type: "heat", from: "b", mda: 1, Tout: 30 },
  ] as any, P), /循环/);
  assert.throws(() => runChain([
    { id: "a", type: "heat", from: "zz", mda: 1, Tout: 30 },
  ] as any, P), /未定义/);
});

test("链错误可定位到节点", () => {
  try {
    runChain([
      { id: "a", type: "state", state: { T: 25, rh: 0.5 } },
      { id: "b", type: "coil", from: "a", mda: 1, Ts: 8, BF: 2 },
    ] as any, P);
    assert.fail("应抛错");
  } catch (e: any) {
    assert.match(e.node, /steps\[1\]/);
  }
});

test("stateFromHW 与 solveState 往返一致", () => {
  const s = solveState(P, { T: 33, rh: 0.45 });
  const r = stateFromHW(s.h, s.W, P);
  assert.ok(Math.abs(r.T - s.T) < 1e-9);
  assert.ok(Math.abs(r.rh - s.rh) < 1e-9);
});
