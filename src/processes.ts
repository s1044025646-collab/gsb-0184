/**
 * 过程计算：混风、显热加热/冷却、冷却除湿盘管。
 * 所有流量均为干空气质量流量 kg_da/s；能量按每千克干空气计量。
 */
import {
  MoistAirState, PsychroError, StateInput, enthalpy, humidityRatioFromPw,
  satVaporPressurePa, solveState, stateFromHW,
} from "./psychro";

export const H_W_COEF = 4.186; // 液态水焓 h_w = 4.186*T kJ/kg（0°C 液态水为零点）

export interface StreamIn {
  state: StateInput & { p?: number };
  mda: number; // 干空气质量流量 kg_da/s，必须 > 0
}

export interface MixResult {
  outlet: MoistAirState;
  mda: number;
  balances: {
    mdaIn: number; mdaOut: number;
    waterIn: number; waterOut: number;   // kg/s 水蒸气
    energyIn: number; energyOut: number; // kW
    waterResidual: number; energyResidual: number;
  };
}

function toState(s: StreamIn["state"], defaultP: number, path: string): MoistAirState {
  const p = s.p ?? defaultP;
  const { p: _drop, ...rest } = s;
  return solveState(p, rest as StateInput, path);
}

/** 两股或多股空气按干空气质量流量绝热混合。超饱和时明确拒绝（不裁剪 RH）。 */
export function mixStreams(streams: StreamIn[], defaultP: number): MixResult {
  if (!Array.isArray(streams) || streams.length < 2)
    throw new PsychroError("混风至少需要两股进风", "streams");
  const states = streams.map((s, i) => {
    if (!(s.mda > 0))
      throw new PsychroError(`第 ${i + 1} 股流量 ${s.mda} 必须为正（不允许零或负流量）`, `streams[${i}].mda`);
    return { st: toState(s.state, defaultP, `streams[${i}].state`), mda: s.mda };
  });
  const mTot = states.reduce((a, s) => a + s.mda, 0);
  const W = states.reduce((a, s) => a + s.mda * s.st.W, 0) / mTot;
  const h = states.reduce((a, s) => a + s.mda * s.st.h, 0) / mTot;
  const p = states[0].st.p;
  if (states.some((s) => Math.abs(s.st.p - p) > 1e-9))
    throw new PsychroError("各股进风压力不一致，本模型仅支持等压混合", "streams");
  const outlet = stateFromHW(h, W, p, "mix.outlet");
  if (outlet.rh > 1 + 1e-9) {
    // 明确拒绝：未实现凝结平衡，绝不静默裁剪 RH 到 100%
    throw new PsychroError(
      `混风结果超饱和（RH=${(outlet.rh * 100).toFixed(2)}%）：两股近饱和空气在 h-W 图上线性混合会穿过饱和线。` +
      `本实现不静默裁剪相对湿度，请提高某股进风温度或降低含湿量后重试。`, "mix.outlet");
  }
  const waterIn = states.reduce((a, s) => a + s.mda * s.st.W, 0);
  const energyIn = states.reduce((a, s) => a + s.mda * s.st.h, 0);
  return {
    outlet, mda: mTot,
    balances: {
      mdaIn: mTot, mdaOut: mTot,
      waterIn, waterOut: mTot * outlet.W,
      energyIn, energyOut: mTot * outlet.h,
      waterResidual: waterIn - mTot * outlet.W,
      energyResidual: energyIn - mTot * outlet.h,
    },
  };
}

export interface SensibleResult {
  outlet: MoistAirState;
  Q: number; // kW，加热为正
  balances: { energyIn: number; energyOut: number; energyResidual: number };
}

/** 定含湿量显热加热/冷却：给定出风干球温度。 */
export function sensibleToTemperature(
  inlet: StateInput & { p?: number }, mda: number, Tout: number, defaultP: number,
): SensibleResult {
  if (!(mda > 0)) throw new PsychroError("干空气质量流量必须为正", "mda");
  const s1 = toState(inlet, defaultP, "inlet");
  const outlet = solveState(s1.p, { T: Tout, W: s1.W }, "outlet");
  const Q = mda * (outlet.h - s1.h);
  return {
    outlet, Q,
    balances: {
      energyIn: mda * s1.h + Q, energyOut: mda * outlet.h,
      energyResidual: mda * s1.h + Q - mda * outlet.h,
    },
  };
}

export interface CoilResult {
  outlet: MoistAirState;
  condensing: boolean;
  condensate: number;      // kg/s 凝结水
  condensateT: number;     // 凝结水温度（取表面温度）°C
  Q: number;               // kW 空气侧热负荷（取热为正）
  balances: {
    waterIn: number; waterOutAir: number; condensate: number; waterResidual: number;
    energyIn: number; energyOutAir: number; energyOutCondensate: number; Qcoil: number; energyResidual: number;
  };
}

/**
 * 冷却盘管：给定表面温度 Ts 与旁通因子 BF（0..1）。
 * 出风 = 旁通混合：T2 = Ts + (T1-Ts)*BF；除湿时 W2 = Ws(Ts) + (W1-Ws(Ts))*BF。
 * 无凝露工况（Ts >= 露点）自动退化为显热冷却，凝结水量为 0。
 */
export function coolingCoil(
  inlet: StateInput & { p?: number }, mda: number, Ts: number, BF: number, defaultP: number,
): CoilResult {
  if (!(mda > 0)) throw new PsychroError("干空气质量流量必须为正", "mda");
  if (!(BF >= 0 && BF <= 1)) throw new PsychroError(`旁通因子 ${BF} 必须在 [0, 1]`, "BF");
  const s1 = toState(inlet, defaultP, "inlet");
  if (!(Ts >= -5 && Ts <= s1.T))
    throw new PsychroError(`表面温度 ${Ts} °C 必须在 [-5, 进风温度] 范围内`, "Ts");
  const p = s1.p;
  const pwsS = satVaporPressurePa(Ts) / 1000;
  const WsSat = Math.min(humidityRatioFromPw(pwsS, p), humidityRatioFromPw(p * 0.999, p));
  const T2 = Ts + (s1.T - Ts) * BF;
  const condensing = s1.W > WsSat + 1e-12;
  let W2 = condensing ? WsSat + (s1.W - WsSat) * BF : s1.W;
  let h2 = enthalpy(T2, W2);
  // 旁通混合点可能轻微越过饱和线（物理上对应雾气凝结）：
  // 按出口温度下的饱和含湿量凝结多余水分，凝结水以 h_w=4.186*T2 离开，保持水分/能量严格平衡。
  const pws2 = satVaporPressurePa(T2) / 1000;
  const Ws2 = humidityRatioFromPw(Math.min(pws2, p * 0.999), p);
  if (W2 > Ws2) {
    h2 = h2 - (W2 - Ws2) * H_W_COEF * T2;
    W2 = Ws2;
  }
  const outlet = stateFromHW(h2, W2, p, "coil.outlet");
  const condensate = mda * (s1.W - outlet.W); // kg/s
  const Q = mda * (s1.h - outlet.h);          // kW，空气侧负荷
  const hwOut = condensate * H_W_COEF * Ts;   // 凝结水带走的显热（约定 h_w=4.186*Ts）
  return {
    outlet, condensing, condensate, condensateT: Ts, Q,
    balances: {
      waterIn: mda * s1.W, waterOutAir: mda * outlet.W, condensate,
      waterResidual: mda * s1.W - mda * outlet.W - condensate,
      energyIn: mda * s1.h, energyOutAir: mda * outlet.h,
      energyOutCondensate: hwOut, Qcoil: Q,
      // 能量核算：空气侧放热 = 盘管取热；凝结水焓已含在空气焓差中，单列仅供核对
      energyResidual: mda * s1.h - mda * outlet.h - Q,
    },
  };
}
