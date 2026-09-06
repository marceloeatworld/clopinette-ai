import type { Context, Next } from "hono";
import { timingSafeEqual } from "./safe-compare.js";

/**
 * API key auth middleware for /api/* routes.
 * Fail-closed: blocks all requests if API_AUTH_KEY is not configured.
 */
export function authMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authKey = c.env.API_AUTH_KEY;

    // Fail-closed: no key = no access (generic message, don't leak secret name)
    if (!authKey) {
      return c.json({ error: "Service not available" }, 503);
    }

    const header = c.req.header("Authorization");
    if (!header) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    const token = header.replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(token, authKey)) {
      return c.json({ error: "Invalid API key" }, 403);
    }

    return next();
  };
}
