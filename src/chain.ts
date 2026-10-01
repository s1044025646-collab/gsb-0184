/**
 * 过程链执行引擎。
 * 链 = 有序步骤数组；state 步骤定义状态点，process 步骤引用上游状态（可跨步骤引用）。
 * - 拒绝循环引用（依赖图拓扑校验）。
 * - 错误携带可定位路径，如 steps[2].inputs.T。
 * - 编辑上游状态 => 以旧链为源创建新快照链（snapshot），旧链只读保留。
 */
import { MoistAirState, PsychroError, solveState, StateInput } from "./psychro";
import { coolingCoil, mixStreams, sensibleToTemperature, CoilResult, MixResult, SensibleResult } from "./processes";
import { Store } from "./store";

export class ChainError extends Error {
  constructor(message: string, public node: string) {
    super(message);
    this.name = "ChainError";
  }
}

export interface ChainStep {
  id: string;                    // 步骤名，供下游引用
  type: "state" | "mix" | "coil" | "heat";
  // state:
  state?: StateInput & { p?: number };
  // mix:
  streams?: { from: string; mda: number }[];
  // coil:
  from?: string; mda?: number; Ts?: number; BF?: number;
  // heat:
  Tout?: number;
  p?: number;                    // 默认大气压力 kPa
}

export interface ExecutedStep {
  id: string; type: string;
  inputs: unknown;
  output: MoistAirState | MixResult | CoilResult | SensibleResult;
  balances: unknown;
}

function fail(msg: string, node: string): never { throw new ChainError(msg, node); }

/** 循环检测：步骤只能引用已定义的上游 id。 */
export function validateChain(steps: ChainStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) fail("过程链为空，缺少步骤", "steps");
  const defined = new Set<string>();
  steps.forEach((s, i) => {
    const node = `steps[${i}]`;
    if (!s.id || typeof s.id !== "string") fail("步骤缺少 id", `${node}.id`);
    if (defined.has(s.id)) fail(`步骤 id "${s.id}" 重复`, `${node}.id`);
    const refs: string[] = [];
    if (s.type === "mix") {
      if (!Array.isArray(s.streams) || s.streams.length < 2)
        fail("混风步骤至少需要两个 streams", `${node}.streams`);
      s.streams!.forEach((st, j) => {
        if (!st.from) fail("混风支流缺少 from 引用", `${node}.streams[${j}].from`);
        refs.push(st.from);
      });
    } else if (s.type === "coil" || s.type === "heat") {
      if (!s.from) fail(`${s.type} 步骤缺少 from 引用`, `${node}.from`);
      refs.push(s.from);
    } else if (s.type === "state") {
      if (!s.state) fail("state 步骤缺少 state 输入", `${node}.state`);
    } else {
      fail(`未知步骤类型 "${s.type}"`, `${node}.type`);
    }
    for (const r of refs) {
      if (r === s.id) fail(`步骤 "${s.id}" 引用自身，构成循环`, `${node}.from`);
      if (!defined.has(r))
        fail(`步骤 "${s.id}" 引用了未定义或下游步骤 "${r}"（不允许循环/前向引用）`, `${node}.from`);
    }
    defined.add(s.id);
  });
}

function getOutlet(step: ExecutedStep): MoistAirState {
  const o: any = step.output;
  if (step.type === "state") return o as MoistAirState;
  if (o && o.outlet) return o.outlet as MoistAirState;
  throw new ChainError(`步骤 "${step.id}" 没有出风状态可供引用`, `steps.${step.id}`);
}

export function runChain(steps: ChainStep[], defaultP: number): ExecutedStep[] {
  validateChain(steps);
  const byId = new Map<string, ExecutedStep>();
  const executed: ExecutedStep[] = [];
  steps.forEach((s, i) => {
    const node = `steps[${i}]`;
    const p = s.p ?? defaultP;
    try {
      if (s.type === "state") {
        const out = solveState(p, s.state!, `${node}.state`);
        executed.push({ id: s.id, type: s.type, inputs: { state: s.state, p }, output: out, balances: null });
      } else if (s.type === "mix") {
        const streams = s.streams!.map((st, j) => {
          const up = byId.get(st.from)!;
          if (!(st.mda > 0))
            throw new PsychroError(`流量 ${st.mda} 必须为正（不允许零或负流量）`, `${node}.streams[${j}].mda`);
          const o = getOutlet(up);
          return { state: { T: o.T, W: o.W, p: o.p }, mda: st.mda };
        });
        const out = mixStreams(streams, p);
        executed.push({ id: s.id, type: s.type, inputs: { streams: s.streams, p }, output: out, balances: out.balances });
      } else if (s.type === "coil") {
        const up = getOutlet(byId.get(s.from!)!);
        const out = coolingCoil({ T: up.T, W: up.W, p: up.p }, s.mda!, s.Ts!, s.BF!, p);
        executed.push({ id: s.id, type: s.type, inputs: { from: s.from, mda: s.mda, Ts: s.Ts, BF: s.BF }, output: out, balances: out.balances });
      } else {
        const up = getOutlet(byId.get(s.from!)!);
        const out = sensibleToTemperature({ T: up.T, W: up.W, p: up.p }, s.mda!, s.Tout!, p);
        executed.push({ id: s.id, type: s.type, inputs: { from: s.from, mda: s.mda, Tout: s.Tout }, output: out, balances: out.balances });
      }
    } catch (e) {
      if (e instanceof PsychroError) {
        const sub = e.path && !e.path.startsWith("steps[") ? `${node}.${e.path}` : e.path;
        throw new ChainError(e.message, sub ?? node);
      }
      throw e;
    }
    byId.set(s.id, executed[executed.length - 1]);
  });
  return executed;
}

/** 执行并持久化一条链；返回链 id 与执行结果。 */
export function runAndSaveChain(store: Store, name: string, steps: ChainStep[], defaultP: number, sourceChainId: number | null = null) {
  const executed = runChain(steps, defaultP);
  const chainId = store.createChain(name, sourceChainId);
  executed.forEach((st, i) => store.addStep(chainId, i, st.id, st.type, st.inputs, st.output, st.balances));
  return { chainId, executed };
}

/** 编辑上游 => 新快照：以 overrides 覆盖指定步骤字段，旧链保留不动。 */
export function snapshotChain(store: Store, chainId: number, overrides: Record<string, Partial<ChainStep>>, defaultP: number, name?: string) {
  const old = store.getChain(chainId);
  if (!old) throw new ChainError(`链 ${chainId} 不存在`, `chains[${chainId}]`);
  const steps: ChainStep[] = old.steps.map((s: any) => rebuildStep(s));
  const merged = steps.map((s) => (overrides[s.id] ? { ...s, ...overrides[s.id] } : s));
  return runAndSaveChain(store, name ?? `${old.name}-snapshot`, merged, defaultP, chainId);
}

function rebuildStep(saved: any): ChainStep {
  const inp = saved.inputs;
  const base: any = { id: saved.name ?? `step${saved.seq}`, type: saved.kind };
  if (saved.kind === "state") { base.state = inp.state; base.p = inp.p; }
  else if (saved.kind === "mix") { base.streams = inp.streams; base.p = inp.p; }
  else if (saved.kind === "coil") { base.from = inp.from; base.mda = inp.mda; base.Ts = inp.Ts; base.BF = inp.BF; }
  else if (saved.kind === "heat") { base.from = inp.from; base.mda = inp.mda; base.Tout = inp.Tout; }
  return base;
}
