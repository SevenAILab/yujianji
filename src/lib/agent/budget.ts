// 当日费用预算：单进程内存计数（spec §4.4），超出返回 BUDGET_EXCEEDED。进程重启会清零，演示环境可接受。
import { AgentError } from "./errors";

let day = "";
let spent = 0;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function roll(): void {
  const current = today();
  if (current !== day) {
    day = current;
    spent = 0;
  }
}

export function dailyBudgetYuan(): number {
  const raw = Number(process.env.MEMO_DAILY_BUDGET_YUAN);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

export function spentTodayYuan(): number {
  roll();
  return spent;
}

export function recordSpend(yuan: number): void {
  roll();
  if (Number.isFinite(yuan) && yuan > 0) spent += yuan;
}

export function assertBudget(): void {
  roll();
  if (spent >= dailyBudgetYuan()) {
    throw new AgentError("BUDGET_EXCEEDED", `今天遇见手记的模型费用已达 ${dailyBudgetYuan()} 元上限`);
  }
}

/** 测试用 */
export function resetBudgetForTest(): void {
  day = today();
  spent = 0;
}
