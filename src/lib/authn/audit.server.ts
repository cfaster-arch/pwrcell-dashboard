/**
 * Tamper-evident audit log (research §7a). SERVER-ONLY.
 *
 * Append-only: this module exposes NO update/delete functions. Each row is
 * hash-chained to the previous one —
 *   row_hash = sha256hex(prev_hash + '|' + canonicalJson)
 * — so silent edits to history are detectable via verifyAuditChain() (it does
 * not stop someone with raw DB write access; it makes tampering detectable).
 *
 * Writes are serialized with an in-process mutex so concurrent auditEvent()
 * calls can never interleave and fork the chain. This is correct for the
 * deployed topology (a single Node process on one VPS); a multi-process
 * deployment would need a DB-level advisory lock instead.
 */

import { createHash } from "node:crypto";
import { getSql, type Sql } from "@/lib/db";

/** Canonical action names. Use these — never free-form strings — for queries. */
export const AUDIT_ACTIONS = {
  AUTH_LOGIN: "auth.login",
  AUTH_LOGOUT: "auth.logout",
  AUTH_LOGIN_FAILED: "auth.login_failed",
  AUTH_PASSWORD_CHANGED: "auth.password_changed",
  AUTH_PASSWORD_RESET: "auth.password_reset",
  USER_CREATED: "user.created",
  USER_DISABLED: "user.disabled",
  USER_ENABLED: "user.enabled",
  USER_DELETED: "user.deleted",
  USER_ROLE_CHANGED: "user.role_changed",
  ORG_CREATED: "org.created",
  ORG_DELETED: "org.deleted",
  CREDENTIALS_SET: "credentials.set",
  CREDENTIALS_CLEARED: "credentials.cleared",
  RING_CONNECTED: "ring.connected",
  RING_DISCONNECTED: "ring.disconnected",
  KIOSK_PAIRED: "kiosk.paired",
  KIOSK_REVOKED: "kiosk.revoked",
  KIOSK_PAIR_CODE_CREATED: "kiosk.pair_code_created",
  /** better-auth's own /api/auth/admin/* invoked by a platform admin. */
  ADMIN_API_CALL: "admin.api_call",
  /** Operator-triggered immediate session revocation. */
  SESSION_REVOKED: "session.revoked",
  /** A platform admin read/exported the audit log (control: reads are logged). */
  AUDIT_EXPORTED: "audit.exported",
  SECURITY_CROSS_ORG_DENIED: "security.cross_org_denied",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** prev_hash stored on the first row of an empty table. */
export const AUDIT_GENESIS_HASH = "GENESIS";

export interface AuditEventInput {
  actorUserId?: string | null;
  actorType?: string;
  /** Use an AUDIT_ACTIONS constant. */
  action: string;
  targetType?: string;
  targetId?: string;
  orgId?: string | null;
  ip?: string;
  userAgent?: string;
}

export interface AuditChainVerification {
  ok: boolean;
  /** Row id where the chain first breaks (prev_hash mismatch or bad row_hash). */
  breakAt?: number;
  /** Number of rows checked. */
  checked: number;
  /**
   * True when the verified window reaches the genesis row (or the table is
   * empty). False means verification stopped at an interior anchor row: the
   * window itself is internally consistent, but a full-table rewrite by
   * someone with DB write access would not be detected — only an externally
   * anchored checkpoint catches that. Callers should surface this.
   */
  reachedGenesis: boolean;
}

/**
 * Canonical field order for the hashed JSON. This order is part of the chain
 * format — it must NEVER change once rows exist, or old rows will fail
 * verification.
 */
const CANON_FIELDS = [
  "ts",
  "actor_type",
  "actor_user_id",
  "action",
  "target_type",
  "target_id",
  "org_id",
  "ip",
  "user_agent",
] as const;

function canonicalEventJson(fields: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANON_FIELDS) {
    ordered[key] = fields[key] ?? null;
  }
  return JSON.stringify(ordered);
}

/** row_hash = sha256hex(prev_hash + '|' + canonicalJson). */
export function hashAuditRow(prevHash: string, canonicalJson: string): string {
  return createHash("sha256").update(prevHash + "|" + canonicalJson, "utf8").digest("hex");
}

interface AuditRow {
  id: number;
  ts: Date | string;
  actor_user_id: string | null;
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  org_id: string | null;
  ip: string | null;
  user_agent: string | null;
  prev_hash: string;
  row_hash: string;
}

function rowFields(row: AuditRow): Record<string, unknown> {
  return {
    ts: new Date(row.ts).toISOString(),
    actor_type: row.actor_type,
    actor_user_id: row.actor_user_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    org_id: row.org_id,
    ip: row.ip,
    user_agent: row.user_agent,
  };
}

// In-process write mutex: concurrent auditEvent() calls serialize here so the
// prev_hash lookup + insert pair can never interleave and fork the chain.
let auditMutex: Promise<void> = Promise.resolve();

function withAuditMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = auditMutex.then(fn, fn);
  auditMutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Cross-process append lock for the audit chain. The in-process mutex below
 * serializes appends inside one Node process, but the admin CLI
 * (scripts/admin-user.mjs) appends from a SEPARATE process against the same
 * database. Without a database-level lock, two appenders can read the same
 * tail row_hash and both insert with the same prev_hash — forking the chain
 * (two valid tails; verifyAuditChain reports it as tampering). This
 * transaction-scoped advisory lock makes the read-tail + insert pair atomic
 * across processes. Both the server and the CLI must take it — see
 * scripts/admin-user.mjs.
 */
const AUDIT_APPEND_LOCK = `select pg_advisory_xact_lock(hashtext('audit_log_append'))`;

/** Read the chain tail and insert one row. Must run inside a transaction that holds AUDIT_APPEND_LOCK. */
async function appendAuditRow(db: Sql, e: AuditEventInput): Promise<void> {
  const ts = new Date().toISOString();
  const fields: Record<string, unknown> = {
    ts,
    actor_type: e.actorType ?? "user",
    actor_user_id: e.actorUserId ?? null,
    action: e.action,
    target_type: e.targetType ?? null,
    target_id: e.targetId ?? null,
    org_id: e.orgId ?? null,
    ip: e.ip ?? null,
    user_agent: e.userAgent ?? null,
  };
  const canonical = canonicalEventJson(fields);
  const prevRows = await db.query<{ row_hash: string }>(
    "select row_hash from audit_log order by id desc limit 1",
  );
  const prevHash = prevRows[0]?.row_hash ?? AUDIT_GENESIS_HASH;
  const rowHash = hashAuditRow(prevHash, canonical);
  await db.query(
    `insert into audit_log
       (ts, actor_user_id, actor_type, action, target_type, target_id, org_id, ip, user_agent, prev_hash, row_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      fields.ts,
      fields.actor_user_id,
      fields.actor_type,
      fields.action,
      fields.target_type,
      fields.target_id,
      fields.org_id,
      fields.ip,
      fields.user_agent,
      prevHash,
      rowHash,
    ],
  );
}

/**
 * Append one audit event. Never throws away data: on any failure the error
 * propagates and nothing is written.
 *
 * Pass `sql` to write inside an existing transaction (e.g. the org-deletion
 * cascade, security review 2026-09-25 R2.10) so the audit row commits or rolls
 * back with the destructive change — the deletion can never land without its
 * audit record. The in-process mutex still serializes concurrent callers, and
 * the advisory lock serializes against other processes (admin CLI).
 */
export async function auditEvent(e: AuditEventInput, sql?: Sql): Promise<void> {
  if (!e.action) throw new Error("[audit] action is required");
  return withAuditMutex(async () => {
    if (sql) {
      // Already inside a caller-owned transaction: take the cross-process
      // lock on it (released when the caller's transaction ends).
      await sql.query(AUDIT_APPEND_LOCK);
      await appendAuditRow(sql, e);
      return;
    }
    const db = await getSql();
    await db.transaction(async (tx) => {
      await tx.query(AUDIT_APPEND_LOCK);
      await appendAuditRow(tx, e);
    });
  });
}

/**
 * Recompute the hash chain over the most recent `limit` rows and check every
 * link — including linkage (each row's prev_hash must equal the previous
 * row's row_hash), so a forked chain (two tails sharing one prev_hash) is
 * reported as tampering rather than passing. Returns { ok: true } when the
 * chain is intact, or { ok: false, breakAt } with the id of the first row
 * whose prev_hash or row_hash does not verify.
 *
 * Reads run OUTSIDE the write mutex on purpose: verification is a single
 * consistent snapshot read, and holding the append lock during a long verify
 * would stall audit logging (a security control) with no benefit. `limit` is
 * capped so one admin request can't pin the database.
 */
const VERIFY_LIMIT_MAX = 5000;

export async function verifyAuditChain(limit = 1000): Promise<AuditChainVerification> {
  const capped = Math.max(1, Math.min(Math.floor(limit) || 1000, VERIFY_LIMIT_MAX));
  const sql = await getSql();
  // Fetch one extra row as an anchor so the oldest row in the window can
  // have its prev_hash checked too.
  const rows = await sql.query<AuditRow>(
    `select id, ts, actor_user_id, actor_type, action, target_type, target_id,
            org_id, ip, user_agent, prev_hash, row_hash
     from audit_log order by id desc limit $1`,
    [capped + 1],
  );
  const asc = rows.slice().reverse();
  const hasAnchor = asc.length === capped + 1;
  const reachedGenesis = !hasAnchor;
  const start = hasAnchor ? 1 : 0;
  let expectedPrev = hasAnchor ? asc[0].row_hash : AUDIT_GENESIS_HASH;
  let checked = 0;
  for (let i = start; i < asc.length; i++) {
    const row = asc[i];
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, breakAt: row.id, checked, reachedGenesis };
    }
    const recomputed = hashAuditRow(row.prev_hash, canonicalEventJson(rowFields(row)));
    if (recomputed !== row.row_hash) {
      return { ok: false, breakAt: row.id, checked, reachedGenesis };
    }
    expectedPrev = row.row_hash;
    checked++;
  }
  return { ok: true, checked, reachedGenesis };
}
