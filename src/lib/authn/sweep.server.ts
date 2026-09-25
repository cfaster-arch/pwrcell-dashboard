/**
 * Periodic hygiene sweep for auth-adjacent tables (Phase 1).
 *
 * Better Auth does not reliably delete expired sessions (the table grows
 * unbounded otherwise — research plan §Phase 1), and the DB-backed
 * rate-limit KV, pairing codes, and login-attempt log need the same
 * treatment. Runs every 15 minutes; started once per process from
 * server.ts (guarded on globalThis so dev HMR doesn't stack intervals).
 */
import { getSql } from "../db";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

const globalRef = globalThis as typeof globalThis & { __authnSweepStarted__?: boolean };

async function sweepOnce() {
  const sql = await getSql();
  try {
    const sessions = await sql`delete from session where expires_at < now()`;
    const kv = await sql`delete from kv_store where expires_at is not null and expires_at < now()`;
    const codes = await sql`delete from pairing_codes where used_at is not null or expires_at < now()`;
    const attempts = await sql`delete from login_attempts where attempted_at < now() - interval '30 days'`;
    console.log(
      `[authn] sweep: removed ${sessions.length} expired sessions, ` +
        `${kv.length} expired kv rows, ${codes.length} pairing codes, ` +
        `${attempts.length} old login attempts`,
    );
  } catch (err) {
    console.error("[authn] sweep failed:", err);
  }
}

export function ensureSweepInterval() {
  if (globalRef.__authnSweepStarted__) return;
  globalRef.__authnSweepStarted__ = true;
  // Run once shortly after boot (tables exist post-migration), then on cadence.
  const timer = setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS);
  // Don't hold the process open for the sweep alone.
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(() => void sweepOnce(), 10_000);
}
