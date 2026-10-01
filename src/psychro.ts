/**
 * 湿空气物性核心模块（教学用，每千克干空气基准）。
 *
 * 约定（README 同步说明）：
 * - 温标：摄氏度（°C），内部求根使用开尔文。
 * - 压力单位：kPa；水蒸气分压输出同为 kPa。
 * - 所有质量流量、含湿量均按「每千克干空气」计量，禁止混用湿空气总质量。
 * - 焓参考态（ASHRAE 惯例）：干空气 0°C 焓为 0；液态水 0°C 焓为 0，
 *   水蒸气 0°C 焓为 2501 kJ/kg。h = 1.006*T + W*(2501 + 1.86*T) [kJ/kg_da]。
 * - 凝结水（液态）焓约定：h_w = 4.186 * T [kJ/kg]，T 为凝结水温度（取盘管表面温度）。
 * - 饱和蒸气压关联式：Hyland-Wexler（ASHRAE Handbook—Fundamentals），
 *   仅使用水面上公式（0..200°C 来源范围）。
 * - 适用范围（文档化限制）：干球温度 0..60 °C，大气压力 80..115 kPa。
 *   不覆盖冰相、结霜与超临界工况；露点允许低至 -40 °C（过冷水面上公式外推，教学可接受）。
 */

export const R_DA = 287.042; // J/(kg·K)，干空气气体常数
export const RATIO_W = 0.621945; // 水蒸气/干空气摩尔质量比
export const T_MIN = 0, T_MAX = 60; // °C
export const P_MIN = 80, P_MAX = 115; // kPa

export class PsychroError extends Error {
  constructor(message: string, public path?: string) {
    super(message);
    this.name = "PsychroError";
  }
}

/** Hyland-Wexler 水面上饱和蒸气压，T 单位 °C，返回 Pa。 */
export function satVaporPressurePa(Tc: number): number {
  const T = Tc + 273.15;
  const C8 = -5.8002206e3, C9 = 1.3914993, C10 = -4.8640239e-2;
  const C11 = 4.1764768e-5, C12 = -1.4452093e-8, C13 = 6.5459673;
  return Math.exp(C8 / T + C9 + C10 * T + C11 * T * T + C12 * T * T * T + C13 * Math.log(T));
}

/** 由水蒸气分压（Pa）反求露点（°C），二分求根。 */
export function dewpointFromVaporPressure(pwPa: number): number {
  if (!(pwPa > 0)) throw new PsychroError("水蒸气分压必须为正，无法求露点");
  let lo = -40, hi = 80;
  if (satVaporPressurePa(lo) > pwPa || satVaporPressurePa(hi) < pwPa) {
    throw new PsychroError("水蒸气分压超出露点求根范围 [-40, 80] °C");
  }
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (satVaporPressurePa(mid) < pwPa) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 含湿量 kg/kg_da，p 与 pw 单位 kPa。 */
export function humidityRatioFromPw(pwKpa: number, pKpa: number): number {
  return (RATIO_W * pwKpa) / (pKpa - pwKpa);
}

export function pwFromHumidityRatio(W: number, pKpa: number): number {
  return (pKpa * W) / (RATIO_W + W);
}

/** 比焓 kJ/kg_da */
export function enthalpy(Tc: number, W: number): number {
  return 1.006 * Tc + W * (2501 + 1.86 * Tc);
}

/** 由 h、W 反求干球温度 °C */
export function temperatureFromHW(h: number, W: number): number {
  return (h - 2501 * W) / (1.006 + 1.86 * W);
}

/** 比容 m3/kg_da */
export function specificVolume(Tc: number, W: number, pKpa: number): number {
  return (R_DA * (Tc + 273.15) * (1 + 1.607858 * W)) / (pKpa * 1000);
}

export interface MoistAirState {
  T: number;      // 干球温度 °C
  W: number;      // 含湿量 kg/kg_da
  rh: number;     // 相对湿度 0..1
  pw: number;     // 水蒸气分压 kPa
  h: number;      // 比焓 kJ/kg_da
  Tdp: number | null; // 露点 °C（零湿度时为 null）
  v: number;      // 比容 m3/kg_da
  p: number;      // 大气压力 kPa
}

export type StateInput =
  | { T: number; rh: number }
  | { T: number; W: number }
  | { T: number; Tdp: number };

export function checkRange(T: number, p: number, path = ""): void {
  if (!Number.isFinite(T) || T < T_MIN || T > T_MAX)
    throw new PsychroError(`干球温度 ${T} °C 超出适用范围 [${T_MIN}, ${T_MAX}] °C`, path);
  if (!Number.isFinite(p) || p < P_MIN || p > P_MAX)
    throw new PsychroError(`大气压力 ${p} kPa 超出适用范围 [${P_MIN}, ${P_MAX}] kPa`, path);
}

/** 由干球温度 + (相对湿度 | 含湿量 | 露点) 求完整状态。 */
export function solveState(p: number, input: StateInput, path = "state"): MoistAirState {
  checkRange(input.T, p, `${path}.T`);
  const pws = satVaporPressurePa(input.T) / 1000; // kPa
  let pw: number;
  if ("rh" in input) {
    if (!(input.rh >= 0 && input.rh <= 1))
      throw new PsychroError(`相对湿度 ${input.rh} 必须在 [0, 1]`, `${path}.rh`);
    pw = input.rh * pws;
  } else if ("W" in input) {
    if (!(input.W >= 0)) throw new PsychroError(`含湿量 ${input.W} 不能为负`, `${path}.W`);
    pw = pwFromHumidityRatio(input.W, p);
    if (pw > pws * (1 + 1e-9))
      throw new PsychroError(`含湿量对应分压超过该温度饱和分压（超饱和），拒绝计算`, `${path}.W`);
  } else {
    if (input.Tdp > input.T + 1e-9)
      throw new PsychroError(`露点 ${input.Tdp} °C 不能高于干球温度 ${input.T} °C`, `${path}.Tdp`);
    pw = satVaporPressurePa(input.Tdp) / 1000;
  }
  const W = humidityRatioFromPw(pw, p);
  const rh = pws > 0 ? pw / pws : 0;
  const Tdp = pw > 0 ? dewpointFromVaporPressure(pw * 1000) : null;
  if (Tdp !== null && Tdp > input.T + 1e-6)
    throw new PsychroError("内部错误：露点高于干球温度", path);
  return {
    T: input.T, W, rh, pw, h: enthalpy(input.T, W), Tdp, v: specificVolume(input.T, W, p), p,
  };
}

/** 由 h、W 重建状态（用于混风结果）。 */
export function stateFromHW(h: number, W: number, p: number, path = "state"): MoistAirState {
  const T = temperatureFromHW(h, W);
  return solveState(p, { T, W }, path);
}
