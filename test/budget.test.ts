import { describe, it, expect } from "vitest";
import { checkBudget } from "../src/enterprise/budget.js";

type MockSqlFn = <T>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

function createMockSql(
  budgetValue: string | null,
  usageTotal: number
): MockSqlFn {
  return <T>(strings: TemplateStringsArray): T[] => {
    const query = strings.join("");
    if (query.includes("token_budget")) {
      return budgetValue
        ? ([{ value: budgetValue }] as T[])
        : ([] as T[]);
    }
    if (query.includes("SUM")) {
      return [{ total: usageTotal }] as T[];
    }
    return [] as T[];
  };
}

describe("budget checking", () => {
  it("returns no budget when not configured", () => {
    const result = checkBudget(createMockSql(null, 0));
    expect(result.budgetSet).toBe(false);
    expect(result.exceeded).toBe(false);
    expect(result.remaining).toBe(Infinity);
  });

  it("reports usage within budget", () => {
    const result = checkBudget(createMockSql("10000", 3000));
    expect(result.budgetSet).toBe(true);
    expect(result.monthlyLimit).toBe(10000);
    expect(result.currentUsage).toBe(3000);
    expect(result.remaining).toBe(7000);
    expect(result.exceeded).toBe(false);
  });

  it("detects exceeded budget", () => {
    const result = checkBudget(createMockSql("10000", 12000));
    expect(result.exceeded).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("detects exactly at limit", () => {
    const result = checkBudget(createMockSql("5000", 5000));
    expect(result.exceeded).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("handles zero budget as no budget", () => {
    const result = checkBudget(createMockSql("0", 100));
    expect(result.budgetSet).toBe(false);
    expect(result.exceeded).toBe(false);
  });
});
