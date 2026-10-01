// 过程链执行引擎：状态求解、混风、显热、盘管组成有向步骤序列，
// 每步记录输入/输出与水分、能量核算；拒绝循环引用与缺失输入。
import { MoistAirState, PsychroError, StateInput, solveState } from "./psychro";
import {
  Balance,
  CoilResult,
  MixResult,
  SensibleResult,
  coolingCoil,
  mix,
  sensible,
} from "./processes";

export interface StateStep {
  id: string;
  type: "state";
  input: StateInput;
}

export interface MixStep {
  id: string;
  type: "mix";
  p: number;
  streams: { from: string; mDa: number }[];
}

export interface SensibleStep {
  id: string;
  type: "sensible";
  from: string;
  mDa: number;
  tOut: number;
}

export interface CoilStep {
  id: string;
  type: "coil";
  from: string;
  mDa: number;
  tSurface: number;
  bypassFactor: number;
}

export type Step = StateStep | MixStep | SensibleStep | CoilStep;

export interface StepRecord {
  id: string;
  type: string;
  input: unknown;
  state?: MoistAirState;
  q?: number;
  condensate?: number;
  sensibleQ?: number;
  latentQ?: number;
  balance?: Balance;
}

function topoSort(steps: Step[]): Step[] {
  const byId = new Map<string, Step>();
  for (const s of steps) {
    if (!s.id) throw new PsychroError("MISSING_INPUT", "每个步骤都需要唯一 id", "steps");
    if (byId.has(s.id)) {
      throw new PsychroError("INVALID_INPUT", "步骤 id " + s.id + " 重复", "steps." + s.id);
    }
    byId.set(s.id, s);
  }
  const deps = (s: Step): string[] => {
    if (s.type === "mix") return s.streams.map((x) => x.from);
    if (s.type === "sensible" || s.type === "coil") return [s.from];
    return [];
  };
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const order: Step[] = [];
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (inStack.has(id)) {
      throw new PsychroError(
        "CYCLE_DETECTED",
        "过程链存在循环引用：" + [...path, id].join(" -> "),
        "steps." + id,
      );
    }
    const step = byId.get(id);
    if (!step) {
      throw new PsychroError("MISSING_INPUT", "步骤 " + id + " 引用了不存在的步骤", "steps." + id);
    }
    inStack.add(id);
    for (const d of deps(step)) visit(d, [...path, id]);
    inStack.delete(id);
    visited.add(id);
    order.push(step);
  };
  for (const s of steps) visit(s.id, []);
  return order;
}

export function executeChain(steps: Step[]): StepRecord[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new PsychroError("MISSING_INPUT", "过程链至少需要一个步骤", "steps");
  }
  const order = topoSort(steps);
  const states = new Map<string, MoistAirState>();
  const records: StepRecord[] = [];

  for (const step of order) {
    const at = "steps." + step.id;
    switch (step.type) {
      case "state": {
        const st = solveState(step.input, at);
        states.set(step.id, st);
        records.push({ id: step.id, type: step.type, input: step.input, state: st });
        break;
      }
      case "mix": {
        const result: MixResult = mix(
          step.streams.map((s) => {
            const st = states.get(s.from);
            if (!st) {
              throw new PsychroError("MISSING_INPUT", "混风引用了未计算的步骤 " + s.from, at);
            }
            return { state: st, mDa: s.mDa };
          }),
          step.p,
          at,
        );
        states.set(step.id, result.state);
        records.push({
          id: step.id,
          type: step.type,
          input: { p: step.p, streams: step.streams },
          state: result.state,
          balance: result.balance,
        });
        break;
      }
      case "sensible": {
        const st = states.get(step.from);
        if (!st) throw new PsychroError("MISSING_INPUT", "引用了未计算的步骤 " + step.from, at);
        const result: SensibleResult = sensible({ state: st, mDa: step.mDa }, step.tOut, at);
        states.set(step.id, result.state);
        records.push({
          id: step.id,
          type: step.type,
          input: { from: step.from, mDa: step.mDa, tOut: step.tOut },
          state: result.state,
          q: result.q,
          balance: result.balance,
        });
        break;
      }
      case "coil": {
        const st = states.get(step.from);
        if (!st) throw new PsychroError("MISSING_INPUT", "引用了未计算的步骤 " + step.from, at);
        const result: CoilResult = coolingCoil(
          { state: st, mDa: step.mDa },
          step.tSurface,
          step.bypassFactor,
          at,
        );
        states.set(step.id, result.state);
        records.push({
          id: step.id,
          type: step.type,
          input: {
            from: step.from,
            mDa: step.mDa,
            tSurface: step.tSurface,
            bypassFactor: step.bypassFactor,
          },
          state: result.state,
          q: result.q,
          condensate: result.condensate,
          sensibleQ: result.sensibleQ,
          latentQ: result.latentQ,
          balance: result.balance,
        });
        break;
      }
      default:
        throw new PsychroError("INVALID_INPUT", "未知步骤类型 " + (step as Step).type, at);
    }
  }
  return records;
}
