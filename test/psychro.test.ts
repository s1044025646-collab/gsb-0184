import { test } from "node:test";
import assert from "node:assert/strict";
import { PsychroError, dewPointFromPw, pws, solveState } from "../src/psychro";

const P = 101.325;

// 参考值：ASHRAE Fundamentals 饱和水蒸气压表（Hyland-Wexler 同源）
test("饱和蒸气压参考值", () => {
  const refs: [number, number][] = [
    [0, 0.6112],
    [20, 2.3393],
    [25, 3.1698],
    [40, 7.3851],
    [60, 19.946],
  ];
  for (const [t, ref] of refs) {
    const got = pws(t);
    assert.ok(Math.abs(got - ref) / ref < 0.002, `pws(${t})=${got} 参考 ${ref}`);
  }
});

test("露点反算与饱和压力互逆", () => {
  for (const t of [1, 12.5, 25, 44.3, 59.9]) {
    const back = dewPointFromPw(pws(t));
    assert.ok(Math.abs(back - t) < 1e-6, `t=${t} 反算得 ${back}`);
  }
});

test("参考状态点：25C/50%RH 海平面（ASHRAE 数据）", () => {
  const s = solveState({ p: P, t: 25, rh: 0.5 });
  assert.ok(Math.abs(s.w - 0.00988) < 5e-5, `W=${s.w}`);
  assert.ok(Math.abs(s.h - 50.3) < 0.2, `h=${s.h}`);
  assert.ok(Math.abs(s.v - 0.858) < 0.005, `v=${s.v}`);
  assert.ok(Math.abs(s.tdp - 13.9) < 0.2, `tdp=${s.tdp}`);
});

test("三种输入形式（rh / w / tdp）结果一致", () => {
  const a = solveState({ p: P, t: 30, rh: 0.6 });
  const b = solveState({ p: P, t: 30, w: a.w });
  const c = solveState({ p: P, t: 30, tdp: a.tdp });
  for (const k of ["w", "h", "rh", "tdp", "pw", "v"] as const) {
    assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `w 输入 ${k} 不一致`);
    assert.ok(Math.abs(a[k] - c[k]) < 1e-6, `tdp 输入 ${k} 不一致`);
  }
});

test("零湿度边界", () => {
  const s = solveState({ p: P, t: 20, rh: 0 });
  assert.equal(s.w, 0);
  assert.equal(s.pw, 0);
  assert.ok(Math.abs(s.h - 1.006 * 20) < 1e-12);
  const s2 = solveState({ p: P, t: 20, w: 0 });
  assert.equal(s2.w, 0);
});

test("任意状态下露点不高于干球温度", () => {
  for (const t of [0.5, 10, 25, 40, 59]) {
    for (const rh of [0.05, 0.3, 0.7, 1.0]) {
      const s = solveState({ p: P, t, rh });
      assert.ok(s.tdp <= s.t + 1e-9, `t=${t} rh=${rh} tdp=${s.tdp}`);
    }
  }
});

test("超范围与非法输入被拒绝且带定位", () => {
  assert.throws(() => solveState({ p: P, t: -5, rh: 0.5 }), (e: PsychroError) => e.code === "OUT_OF_RANGE");
  assert.throws(() => solveState({ p: 200, t: 25, rh: 0.5 }), (e: PsychroError) => e.code === "OUT_OF_RANGE");
  assert.throws(() => solveState({ p: P, t: 25, rh: 1.5 }), (e: PsychroError) => e.code === "INVALID_INPUT");
  assert.throws(() => solveState({ p: P, t: 25, tdp: 30 }), (e: PsychroError) => e.code === "INVALID_INPUT");
  assert.throws(() => solveState({ p: P, t: 25, w: 0.05 }), (e: PsychroError) => e.code === "SUPER_SATURATED");
  try {
    solveState({ p: P, t: 25, rh: 2 }, "steps[0].input");
    assert.fail("应抛出");
  } catch (e) {
    assert.equal((e as PsychroError).node, "steps[0].input");
  }
});
