import { test } from "node:test";
import assert from "node:assert/strict";
import { PsychroError, solveState } from "../src/psychro";
import { coolingCoil, mix, sensible } from "../src/processes";
import { executeChain, Step } from "../src/engine";

const P = 101.325;

test("混风：水分与焓按干空气质量守恒", () => {
  const a = solveState({ p: P, t: 32, rh: 0.7 });
  const b = solveState({ p: P, t: 18, rh: 0.4 });
  const r = mix([{ state: a, mDa: 1.2 }, { state: b, mDa: 0.8 }], P);
  // 独立守恒断言：直接由进风状态加权计算，不经过 mix 内部公式
  const wRef = (1.2 * a.w + 0.8 * b.w) / 2.0;
  const hRef = (1.2 * a.h + 0.8 * b.h) / 2.0;
  assert.ok(Math.abs(r.state.w - wRef) < 1e-12);
  assert.ok(Math.abs(r.state.h - hRef) < 1e-9);
  assert.ok(Math.abs(r.balance.waterIn - r.balance.waterOut) < 1e-12);
});

test("等状态混风结果不变", () => {
  const a = solveState({ p: P, t: 26, rh: 0.55 });
  const r = mix([{ state: a, mDa: 1 }, { state: a, mDa: 2.5 }], P);
  assert.ok(Math.abs(r.state.t - a.t) < 1e-9);
  assert.ok(Math.abs(r.state.w - a.w) < 1e-12);
});

test("混风超饱和被明确拒绝（不裁剪 RH）", () => {
  const cold = solveState({ p: P, t: 2, rh: 1.0 });
  const warm = solveState({ p: P, t: 35, rh: 0.95 });
  assert.throws(
    () => mix([{ state: cold, mDa: 1 }, { state: warm, mDa: 1 }], P),
    (e: PsychroError) => e.code === "MIX_SUPER_SATURATED",
  );
});

test("显热过程含湿量不变", () => {
  const a = solveState({ p: P, t: 20, rh: 0.5 });
  const r = sensible({ state: a, mDa: 1.5 }, 35);
  assert.equal(r.state.w, a.w);
  assert.ok(r.q > 0);
  // 独立校验：Q = m*cp*(t2-t1)，cp 取 1.006+1.86W
  const qRef = 1.5 * (1.006 + 1.86 * a.w) * 15;
  assert.ok(Math.abs(r.q - qRef) < 1e-9);
});

test("旁通因子极限：BF=1 无处理，BF=0 全接触", () => {
  const inlet = solveState({ p: P, t: 32, rh: 0.6 });
  const bf1 = coolingCoil({ state: inlet, mDa: 1 }, 8, 1);
  assert.ok(Math.abs(bf1.state.t - inlet.t) < 1e-9);
  assert.ok(Math.abs(bf1.state.w - inlet.w) < 1e-12);
  assert.ok(Math.abs(bf1.q) < 1e-9);
  assert.equal(bf1.condensate, 0);

  const bf0 = coolingCoil({ state: inlet, mDa: 1 }, 8, 0);
  assert.ok(Math.abs(bf0.state.t - 8) < 1e-9);
  assert.ok(Math.abs(bf0.state.rh - 1) < 1e-6, "全接触出风应饱和");
  assert.ok(bf0.condensate > 0);
});

test("无凝露冷却：表面温度高于露点", () => {
  const inlet = solveState({ p: P, t: 30, rh: 0.3 });
  const r = coolingCoil({ state: inlet, mDa: 2 }, 15, 0.2);
  assert.equal(r.condensate, 0);
  assert.equal(r.state.w, inlet.w);
  assert.ok(Math.abs(r.state.t - (15 + 0.2 * 15)) < 1e-9);
  assert.ok(Math.abs(r.latentQ) < 1e-9);
});

test("结露冷却：水量与能量平衡残差为零", () => {
  const inlet = solveState({ p: P, t: 32, rh: 0.6 });
  const r = coolingCoil({ state: inlet, mDa: 1.5 }, 8, 0.1);
  assert.ok(r.condensate > 0);
  assert.ok(Math.abs(r.balance.residualWater) < 1e-12);
  assert.ok(Math.abs(r.balance.residualEnergy) < 1e-9);
  // 独立水量校验：凝结水 = 干空气质量流量 * 含湿量差
  assert.ok(Math.abs(r.condensate - 1.5 * (inlet.w - r.state.w)) < 1e-12);
  assert.ok(r.state.w < inlet.w && r.state.w > 0);
});

test("非法过程参数被拒绝", () => {
  const inlet = solveState({ p: P, t: 30, rh: 0.5 });
  assert.throws(() => coolingCoil({ state: inlet, mDa: -1 }, 8, 0.1), (e: PsychroError) => e.code === "INVALID_INPUT");
  assert.throws(() => coolingCoil({ state: inlet, mDa: 1 }, 8, 1.5), (e: PsychroError) => e.code === "INVALID_INPUT");
  assert.throws(() => coolingCoil({ state: inlet, mDa: 1 }, 35, 0.1), (e: PsychroError) => e.code === "INVALID_INPUT");
  assert.throws(() => mix([{ state: inlet, mDa: 1 }], P), (e: PsychroError) => e.code === "MISSING_INPUT");
});

test("过程链：循环引用被拒绝", () => {
  const steps: Step[] = [
    { id: "a", type: "sensible", from: "b", mDa: 1, tOut: 20 },
    { id: "b", type: "sensible", from: "a", mDa: 1, tOut: 20 },
  ];
  assert.throws(() => executeChain(steps), (e: PsychroError) => e.code === "CYCLE_DETECTED");
});

test("过程链：缺失输入与不存在的引用被拒绝", () => {
  assert.throws(() => executeChain([]), (e: PsychroError) => e.code === "MISSING_INPUT");
  const steps: Step[] = [{ id: "x", type: "sensible", from: "ghost", mDa: 1, tOut: 20 }];
  assert.throws(() => executeChain(steps), (e: PsychroError) => e.code === "MISSING_INPUT");
});

test("过程链：混风-盘管-再热全链核算", () => {
  const steps: Step[] = [
    { id: "oa", type: "state", input: { p: P, t: 34, rh: 0.65 } },
    { id: "ra", type: "state", input: { p: P, t: 26, rh: 0.55 } },
    { id: "ma", type: "mix", p: P, streams: [{ from: "oa", mDa: 0.4 }, { from: "ra", mDa: 1.1 }] },
    { id: "cc", type: "coil", from: "ma", mDa: 1.5, tSurface: 8, bypassFactor: 0.1 },
    { id: "sa", type: "sensible", from: "cc", mDa: 1.5, tOut: 20 },
  ];
  const records = executeChain(steps);
  assert.equal(records.length, 5);
  const cc = records.find((r) => r.id === "cc")!;
  assert.ok((cc.condensate ?? 0) > 0);
  const sa = records.find((r) => r.id === "sa")!;
  assert.ok(Math.abs(sa.state!.t - 20) < 1e-9);
  assert.ok(Math.abs(sa.state!.w - cc.state!.w) < 1e-12);
});
