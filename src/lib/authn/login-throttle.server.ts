/**
 * DB-backed login throttling (Phase 1, research §7a / KEEP list).
 *
 * SERVER-ONLY. Wraps better-auth's /api/auth/sign-in/email endpoint
 * (see src/routes/api/auth/$.ts):
 * - counts failed attempts per email OR per IP in a trailing 15-minute window
 * - 5+ failures → progressive pre-auth delay (1s, 2s, 4s, … capped at 8s)
 * - 10+ failures → 15-minute lockout (HTTP 429 + Retry-After)
 * - every attempt is recorded in login_attempts (swept after 30 days)
 *
 * Errors are non-enumerating: the lockout response is identical whether the
 * email exists or not, and wrong-password vs unknown-email both come back
 * from better-auth as the same 401 (verified in the smoke test).
 */

import { getSql } from "../db";

const WINDOW_MINUTES = 15;
const DELAY_AFTER_FAILURES = 5;
const LOCKOUT_AFTER_FAILURES = 10;
const MAX_DELAY_MS = 8000;

/**
 * Proxies we strip from the right of X-Forwarded-For (mirrors the
 * `advanced.ipAddress.trustedProxies` in server.ts — nginx on this host).
 * An attacker can prepend arbitrary entries to XFF; only the entry left of
 * the trusted proxies is the real client IP.
 */
const TRUSTED_PROXY_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Best-effort client IP: rightmost X-Forwarded-For entry that isn't a trusted proxy. */
export function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff
      .split(",")
      .map((s) => s.trim().replace(/^\[|\]$/g, ""))
      .filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!TRUSTED_PROXY_IPS.has(hops[i].toLowerCase())) return hops[i];
    }
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "direct";
}

export interface ThrottleDecision {
  /** false → caller must return 429, not call better-auth. */
  allowed: boolean;
  /** ms to sleep before attempting auth (progressive delay). 0 = none. */
  delayMs: number;
  /** seconds for the Retry-After header when locked out. */
  retryAfterS: number;
}

/**
 * Count recent failures for this email or IP. Lockout/delay thresholds are
 * on the combined count — an attacker rotating emails from one IP still
 * trips the IP side, and a targeted account still trips the email side.
 */
export async function checkLoginThrottle(
  email: string,
  ip: string,
): Promise<ThrottleDecision> {
  const sql = await getSql();
  const rows = await sql<{ count: string; retry_after_s: string | null }>`
    select count(*)::text as count,
           -- seconds until the newest failure in the window ages out;
           -- computed in SQL so we never depend on V8 parsing PG's
           -- timestamp text format (a NaN here would emit "Retry-After: NaN").
           greatest(
             0,
             ceil(
               extract(
                 epoch from (max(attempted_at) + (${WINDOW_MINUTES} || ' minutes')::interval - now())
               )
             )
           )::text as retry_after_s
    from login_attempts
    where success = false
      and attempted_at > now() - (${WINDOW_MINUTES} || ' minutes')::interval
      and (lower(email) = lower(${email}) or ip = ${ip})`;
  const failures = Number(rows[0]?.count ?? 0);

  if (failures >= LOCKOUT_AFTER_FAILURES) {
    return {
      allowed: false,
      delayMs: 0,
      retryAfterS: Math.max(1, Number(rows[0]?.retry_after_s ?? 0)),
    };
  }
  if (failures >= DELAY_AFTER_FAILURES) {
    // 5th failure → 1s, 6th → 2s, 7th → 4s, … capped at 8s.
    const delayMs = Math.min(1000 * 2 ** (failures - DELAY_AFTER_FAILURES), MAX_DELAY_MS);
    return { allowed: true, delayMs, retryAfterS: 0 };
  }
  return { allowed: true, delayMs: 0, retryAfterS: 0 };
}

/** Record one attempt. Never throws — a logging failure must not break auth. */
export async function recordLoginAttempt(
  email: string,
  ip: string,
  success: boolean,
): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      insert into login_attempts (email, ip, success)
      values (${email}, ${ip}, ${success})`;
  } catch (err) {
    console.error("[authn] failed to record login attempt:", (err as Error).message);
  }
}

export const LOGIN_THROTTLE = {
  WINDOW_MINUTES,
  DELAY_AFTER_FAILURES,
  LOCKOUT_AFTER_FAILURES,
} as const;
