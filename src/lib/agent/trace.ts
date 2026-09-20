// 每次运行的过程记录：服务端组装、随响应返回、前端存 IndexedDB（D5）。写入时统一脱敏截断。
import type { AgentTrace, TraceScope, TraceStep } from "../memo/types";
import { clampSummary } from "./redact";

export class TraceBuilder {
  readonly runId: string;
  readonly scope: TraceScope;
  readonly refId: string;
  private readonly sessionId?: string;
  private readonly dayKey?: string;
  private readonly startedAt = Date.now();
  private readonly steps: TraceStep[] = [];
  private cost = 0;
  private estimated = false;
  private model?: string;

  constructor(scope: TraceScope, refId: string, meta: { runId: string; sessionId?: string; dayKey?: string }) {
    this.scope = scope;
    this.refId = refId;
    this.runId = meta.runId;
    this.sessionId = meta.sessionId;
    this.dayKey = meta.dayKey;
  }

  push(step: TraceStep): void {
    this.steps.push({
      ...step,
      ms: Math.max(0, Math.round(step.ms)),
      summary: clampSummary(step.summary),
      ...(step.reason ? { reason: clampSummary(step.reason) } : {}),
    });
  }

  addCost(yuan: number, estimated: boolean): void {
    if (Number.isFinite(yuan)) this.cost += yuan;
    if (estimated) this.estimated = true;
  }

  setModel(modelId: string): void {
    this.model ??= modelId;
  }

  markEstimated(): void {
    this.estimated = true;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  build(outcome: AgentTrace["outcome"], limitHit?: AgentTrace["limitHit"]): AgentTrace {
    return {
      runId: this.runId,
      scope: this.scope,
      refId: this.refId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.dayKey ? { dayKey: this.dayKey } : {}),
      startedAt: new Date(this.startedAt).toISOString(),
      ms: this.elapsedMs(),
      costYuan: Math.round(this.cost * 1e6) / 1e6,
      ...(this.estimated ? { costEstimated: true } : {}),
      ...(this.model ? { model: this.model } : {}),
      outcome,
      ...(limitHit ? { limitHit } : {}),
      steps: [...this.steps],
    };
  }
}
