import type { SqlFn } from "../config/sql.js";

/**
 * Token budget enforcement.
 *
 * Budget is stored in agent_config as 'token_budget' (monthly limit).
 * Usage is tracked in the durable `monthly_tokens` counter, with a fallback to
 * `sessions.total_tokens` for older DOs that have not bootstrapped yet.
 * When budget is exceeded, chat is paused until next month or budget increase.
 */

export interface BudgetStatus {
  budgetSet: boolean;
  monthlyLimit: number;
  currentUsage: number;
  remaining: number;
  exceeded: boolean;
}

/**
 * Read the durable monthly usage counter.
 *
 * Falls back to summing `sessions.total_tokens` when the counter row has not
 * been bootstrapped yet, so older DOs still report the correct usage.
 */
export function readMonthlyUsage(sql: SqlFn): number {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM

  const counterRow = sql<{ total: number }>`
    SELECT total FROM monthly_tokens WHERE month = ${month}
  `;
  if (counterRow.length > 0) return counterRow[0].total ?? 0;

  const monthStart = `${month}-01`;
  const usageRow = sql<{ total: number }>`
    SELECT COALESCE(SUM(total_tokens), 0) as total FROM sessions
    WHERE started_at >= ${monthStart}
  `;
  return usageRow[0]?.total ?? 0;
}

export function checkBudget(sql: SqlFn): BudgetStatus {
  // Get budget limit
  const budgetRow = sql<{ value: string }>`
    SELECT value FROM agent_config WHERE key = 'token_budget'
  `;
  const monthlyLimit = budgetRow.length > 0 ? parseInt(budgetRow[0].value, 10) : 0;

  if (!monthlyLimit) {
    return { budgetSet: false, monthlyLimit: 0, currentUsage: 0, remaining: Infinity, exceeded: false };
  }

  const currentUsage = readMonthlyUsage(sql);
  const remaining = monthlyLimit - currentUsage;

  return {
    budgetSet: true,
    monthlyLimit,
    currentUsage,
    remaining: Math.max(0, remaining),
    exceeded: currentUsage >= monthlyLimit,
  };
}
