/**
 * 湿空气物性核心模块。
 *
 * 约定（全项目统一）：
 * - 温度：摄氏度 (°C)；饱和蒸气压关联式内部使用开尔文。
 * - 压力：kPa。
 * - 含湿量 W：kg 水蒸气 / kg 干空气。
 * - 焓 h：kJ / kg 干空气。参考态：干空气焓在 0°C 为 0；液态水焓在 0°C 为 0
 *   （即 0°C 饱和水蒸气的焓取汽化潜热 2501 kJ/kg，ASHRAE 惯例）。
 * - 所有流量均为干空气质量流量 kg(da)/s，绝不使用湿空气总质量。
 *
 * 关联式来源：
 * - 饱和水蒸气压：ASHRAE Handbook—Fundamentals (2009) Hyland-Wexler 方程，
 *   适用 0–200 °C 水面上方。本服务限定干球 0–60 °C、露点 0–60 °C。
 * - 焓：h = 1.006*T + W*(2501 + 1.86*T)  (ASHRAE, kJ/kg da)
 * - 比容：v = R_da*T_K*(1 + 1.607858*W) / p，R_da = 287.042 J/(kg·K)
 * - 湿度比：W = 0.621945 * p_w / (p - p_w)
 */

export const C_DA = 1.006; // kJ/(kg da·K)
export const C_V = 1.86; // kJ/(kg 水蒸气·K)
export const H_FG0 = 2501; // 0°C 汽化潜热 kJ/kg
export const C_W = 4.186; // 液态水比热 kJ/(kg·K)
export const R_DA = 287.042; // J/(kg da·K)
export const MW_RATIO = 0.621945; // 水/干空气摩尔质量比

export const RANGE = {
  tMin: 0,
  tMax: 60,
  pMin: 80,
  pMax: 115,
};

export class PsychroError extends Error {
  constructor(
    public code: string,
    message: string,
    public node?: string,
  ) {
    super(message);
    this.name = "PsychroError";
  }
}

function assertRange(t: number, p: number, node?: string): void {
  if (!Number.isFinite(t) || !Number.isFinite(p)) {
    throw new PsychroError("INVALID_INPUT", "温度或压力不是有限数值", node);
  }
  if (t < RANGE.tMin || t > RANGE.tMax) {
    throw new PsychroError(
      "OUT_OF_RANGE",
      `干球温度 ${t}°C 超出适用范围 [${RANGE.tMin}, ${RANGE.tMax}]°C（不包含冰相/结霜工况）`,
      node,
    );
  }
  if (p < RANGE.pMin || p > RANGE.pMax) {
    throw new PsychroError(
      "OUT_OF_RANGE",
      `大气压力 ${p} kPa 超出适用范围 [${RANGE.pMin}, ${RANGE.pMax}] kPa`,
      node,
    );
  }
}

/** Hyland-Wexler 饱和水蒸气压，T 单位 °C，返回 kPa。 */
export function pws(tC: number): number {
  const T = tC + 273.15;
  const lnP =
    -5.8002206e3 / T +
    1.3914993 +
    -4.8640239e-2 * T +
    4.1764768e-5 * T * T +
    -1.4452093e-8 * T * T * T +
    6.5459673 * Math.log(T);
  return Math.exp(lnP) / 1000; // Pa -> kPa
}

/** 由水蒸气分压 (kPa) 反求露点温度 (°C)，二分法。 */
export function dewPointFromPw(pw: number): number {
  if (!(pw > 0)) {
    throw new PsychroError("INVALID_INPUT", `水蒸气分压 ${pw} kPa 必须为正`);
  }
  let lo = RANGE.tMin - 1e-9;
  let hi = RANGE.tMax + 1e-9;
  if (pw > pws(hi)) {
    throw new PsychroError(
      "OUT_OF_RANGE",
      `水蒸气分压 ${pw} kPa 对应露点超出适用范围`,
    );
  }
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (pws(mid) < pw) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** 由含湿量求水蒸气分压 (kPa)。 */
export function pwFromW(w: number, p: number): number {
  return (p * w) / (MW_RATIO + w);
}

/** 由水蒸气分压求含湿量。 */
export function wFromPw(pw: number, p: number): number {
  return (MW_RATIO * pw) / (p - pw);
}

/** 焓 kJ/kg da。 */
export function enthalpy(t: number, w: number): number {
  return C_DA * t + w * (H_FG0 + C_V * t);
}

/** 由焓与含湿量反求干球温度。 */
export function tFromHW(h: number, w: number): number {
  return (h - w * H_FG0) / (C_DA + C_V * w);
}

/** 液态水焓 kJ/kg（0°C 为 0）。 */
export function waterEnthalpy(t: number): number {
  return C_W * t;
}

export interface MoistAirState {
  p: number; // kPa 大气压力
  t: number; // °C 干球温度
  w: number; // kg/kg da 含湿量
  rh: number; // 0-1 相对湿度
  h: number; // kJ/kg da 焓
  pw: number; // kPa 水蒸气分压
  tdp: number; // °C 露点
  v: number; // m3/kg da 比容
}

export function buildState(t: number, w: number, p: number): MoistAirState {
  const pw = pwFromW(w, p);
  const pwsT = pws(t);
  return {
    p,
    t,
    w,
    rh: pw / pwsT,
    h: enthalpy(t, w),
    pw,
    tdp: w > 0 ? dewPointFromPw(pw) : RANGE.tMin,
    v: (R_DA * (t + 273.15) * (1 + 1.607858 * w)) / (p * 1000),
  };
}

export type StateInput =
  | { p: number; t: number; rh: number }
  | { p: number; t: number; w: number }
  | { p: number; t: number; tdp: number };

/**
 * 由干球温度 + (相对湿度 | 含湿量 | 露点) 求完整状态。
 * node 用于错误定位（如 "steps[2].state"）。
 */
export function solveState(input: StateInput, node?: string): MoistAirState {
  const { p, t } = input;
  assertRange(t, p, node);
  let w: number;
  if ("rh" in input) {
    const rh = input.rh;
    if (!(rh >= 0 && rh <= 1)) {
      throw new PsychroError("INVALID_INPUT", `相对湿度 ${rh} 必须在 [0,1]`, node);
    }
    w = wFromPw(rh * pws(t), p);
  } else if ("w" in input) {
    w = input.w;
    if (!(w >= 0)) {
      throw new PsychroError("INVALID_INPUT", `含湿量 ${w} 不能为负`, node);
    }
    const pw = pwFromW(w, p);
    if (pw > pws(t) * (1 + 1e-9)) {
      throw new PsychroError(
        "SUPER_SATURATED",
        `含湿量 ${w} 在 ${t}°C 下过饱和（RH=${(pw / pws(t)).toFixed(4)} > 1）`,
        node,
      );
    }
  } else if ("tdp" in input) {
    const tdp = input.tdp;
    if (tdp < RANGE.tMin || tdp > RANGE.tMax) {
      throw new PsychroError(
        "OUT_OF_RANGE",
        `露点 ${tdp}°C 超出适用范围 [${RANGE.tMin}, ${RANGE.tMax}]°C`,
        node,
      );
    }
    if (tdp > t + 1e-9) {
      throw new PsychroError(
        "INVALID_INPUT",
        `露点 ${tdp}°C 不能高于干球温度 ${t}°C`,
        node,
      );
    }
    w = wFromPw(pws(tdp), p);
  } else {
    throw new PsychroError(
      "MISSING_INPUT",
      "需要 rh、w、tdp 三者之一作为第二参数",
      node,
    );
  }
  return buildState(t, w, p);
}
