import type { SqlFn } from "../config/sql.js";

/**
 * Token budget enforcement.
 *
 * Budget is stored in agent_config as 'token_budget' (monthly limit).
 * Usage is tracked in the sessions table (total_tokens column).
 * When budget is exceeded, chat is paused until next month or budget increase.
 */

export interface BudgetStatus {
  budgetSet: boolean;
  monthlyLimit: number;
  currentUsage: number;
  remaining: number;
  exceeded: boolean;
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

  // Sum tokens for current month
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

  const usageRow = sql<{ total: number }>`
    SELECT COALESCE(SUM(total_tokens), 0) as total FROM sessions
    WHERE started_at >= ${monthStart}
  `;
  const currentUsage = usageRow[0]?.total ?? 0;
  const remaining = monthlyLimit - currentUsage;

  return {
    budgetSet: true,
    monthlyLimit,
    currentUsage,
    remaining: Math.max(0, remaining),
    exceeded: currentUsage >= monthlyLimit,
  };
}
