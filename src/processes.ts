/**
 * 湿空气过程计算：混风、定含湿量显热加热/冷却、冷却盘管（旁通因子模型）。
 * 所有流量为干空气质量流量 kg(da)/s，负荷单位 kW (kJ/s)。
 */
import {
  MoistAirState,
  PsychroError,
  buildState,
  enthalpy,
  pws,
  tFromHW,
  wFromPw,
  waterEnthalpy,
} from "./psychro";

export interface StreamInput {
  state: MoistAirState;
  mDa: number; // kg(da)/s
}

export interface Balance {
  mDaIn: number;
  mDaOut: number;
  waterIn: number; // kg/s 水蒸气
  waterOut: number;
  condensate: number; // kg/s 凝结水
  energyIn: number; // kW
  energyOut: number; // kW（含凝结水带走的焓）
  residualEnergy: number; // 应接近 0
  residualWater: number;
}

export interface MixResult {
  state: MoistAirState;
  balance: Balance;
}

/** 两股（或多股）空气按干空气质量流量混合。超饱和时明确拒绝。 */
export function mix(streams: StreamInput[], p: number, node?: string): MixResult {
  if (!Array.isArray(streams) || streams.length < 2) {
    throw new PsychroError("MISSING_INPUT", "混风至少需要两股气流", node);
  }
  let mTot = 0;
  let hSum = 0;
  let wSum = 0;
  streams.forEach((s, i) => {
    const at = node ? `${node}.streams[${i}]` : `streams[${i}]`;
    if (!(s.mDa > 0)) {
      throw new PsychroError("INVALID_INPUT", `干空气质量流量必须为正，收到 ${s.mDa}`, at);
    }
    if (Math.abs(s.state.p - p) > 1e-6) {
      throw new PsychroError("INVALID_INPUT", "各股气流压力必须与混合压力一致", at);
    }
    mTot += s.mDa;
    hSum += s.mDa * s.state.h;
    wSum += s.mDa * s.state.w;
  });
  const w = wSum / mTot;
  const h = hSum / mTot;
  const t = tFromHW(h, w);
  const pw = (p * w) / (0.621945 + w);
  if (pw > pws(t) * (1 + 1e-9)) {
    // 明确拒绝，不静默裁剪 RH=100%。
    throw new PsychroError(
      "MIX_SUPER_SATURATED",
      `混风后状态超饱和（t=${t.toFixed(2)}°C, w=${w.toFixed(5)} kg/kg, ` +
        `分压 ${pw.toFixed(4)} kPa > 饱和分压 ${pws(t).toFixed(4)} kPa）。` +
        `本服务不静默将相对湿度裁剪为 100%，请调整进风参数或改用带凝结的盘管模型。`,
      node,
    );
  }
  const state = buildState(t, w, p);
  return {
    state,
    balance: {
      mDaIn: mTot,
      mDaOut: mTot,
      waterIn: wSum,
      waterOut: mTot * w,
      condensate: 0,
      energyIn: hSum,
      energyOut: mTot * h,
      residualEnergy: 0,
      residualWater: 0,
    },
  };
}

export interface SensibleResult {
  state: MoistAirState;
  q: number; // kW，正为加热
  balance: Balance;
}

/** 定含湿量显热加热/冷却到目标干球温度。 */
export function sensible(
  input: StreamInput,
  tOut: number,
  node?: string,
): SensibleResult {
  if (!(input.mDa > 0)) {
    throw new PsychroError("INVALID_INPUT", `干空气质量流量必须为正，收到 ${input.mDa}`, node);
  }
  const state = buildState(tOut, input.state.w, input.state.p);
  const q = input.mDa * (state.h - input.state.h);
  return {
    state,
    q,
    balance: {
      mDaIn: input.mDa,
      mDaOut: input.mDa,
      waterIn: input.mDa * input.state.w,
      waterOut: input.mDa * state.w,
      condensate: 0,
      energyIn: input.mDa * input.state.h + q,
      energyOut: input.mDa * state.h,
      residualEnergy: 0,
      residualWater: 0,
    },
  };
}

export interface CoilResult {
  state: MoistAirState;
  condensate: number; // kg/s 凝结水量（>=0）
  q: number; // kW 盘管总冷负荷（正表示从空气取热）
  sensibleQ: number; // kW 显热部分
  latentQ: number; // kW 潜热部分
  balance: Balance;
}

/**
 * 冷却盘管：给定表面温度 tSurface 与旁通因子 BF。
 * 出风为“接触部分（达到表面温度对应的饱和状态）”与“旁通部分（进风状态）”的混合：
 *   tOut = tSurface + BF*(tIn - tSurface)
 *   wOut = wSurface + BF*(wIn - wSurface)，wSurface 为表面温度下饱和含湿量
 * 若表面温度不低于进风露点，则无凝露：wOut = wIn，仅显热冷却。
 * 能量平衡：q = mDa*(hIn - hOut) - mCond*hWater(tSurface)，
 * 即凝结水以表面温度液态离开，其焓不计入出风但计入负荷。
 */
export function coolingCoil(
  input: StreamInput,
  tSurface: number,
  bypassFactor: number,
  node?: string,
): CoilResult {
  const at = node ?? "coil";
  const { state: sIn, mDa } = input;
  if (!(mDa > 0)) {
    throw new PsychroError("INVALID_INPUT", `干空气质量流量必须为正，收到 ${mDa}`, at);
  }
  if (!(bypassFactor >= 0 && bypassFactor <= 1)) {
    throw new PsychroError("INVALID_INPUT", `旁通因子必须在 [0,1]，收到 ${bypassFactor}`, at);
  }
  if (tSurface < 0 || tSurface > 60) {
    throw new PsychroError("OUT_OF_RANGE", `表面温度 ${tSurface}°C 超出适用范围 [0,60]°C`, at);
  }
  if (tSurface >= sIn.t) {
    throw new PsychroError(
      "INVALID_INPUT",
      `冷却盘管表面温度 ${tSurface}°C 必须低于进风干球温度 ${sIn.t}°C`,
      at,
    );
  }

  const p = sIn.p;
  const wSatSurface = wFromPw(pws(tSurface), p);
  const condensing = sIn.w > wSatSurface; // 等价于 tSurface < 进风露点

  const tOut = tSurface + bypassFactor * (sIn.t - tSurface);
  let wOut = condensing
    ? wSatSurface + bypassFactor * (sIn.w - wSatSurface)
    : sIn.w;
  // 旁通因子模型的出风可能微过饱和（出风温度低于表面温度对应的饱和线时），
  // 物理上多余水分继续凝结，出风沿饱和线修正到 tOut 对应的饱和含湿量。
  const wSatOut = wFromPw(pws(tOut), p);
  if (wOut > wSatOut) {
    wOut = wSatOut;
  }

  const sOut = buildState(tOut, wOut, p);
  const mCond = mDa * (sIn.w - wOut); // kg/s
  const q = mDa * (sIn.h - sOut.h) - mCond * waterEnthalpy(tSurface);
  const sensibleQ = mDa * 1.006 * (sIn.t - tOut) + mDa * 1.86 * (sIn.w * sIn.t - wOut * tOut);
  const latentQ = q - sensibleQ;

  return {
    state: sOut,
    condensate: mCond,
    q,
    sensibleQ,
    latentQ,
    balance: {
      mDaIn: mDa,
      mDaOut: mDa,
      waterIn: mDa * sIn.w,
      waterOut: mDa * wOut + mCond,
      condensate: mCond,
      energyIn: mDa * sIn.h,
      energyOut: mDa * sOut.h + mCond * waterEnthalpy(tSurface) + q,
      residualEnergy:
        mDa * sIn.h - (mDa * sOut.h + mCond * waterEnthalpy(tSurface) + q),
      residualWater: mDa * sIn.w - (mDa * wOut + mCond),
    },
  };
}

export { enthalpy };
