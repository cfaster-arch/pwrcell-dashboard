/**
 * Phase 2 two-org isolation tests.
 *
 * All fixtures — no real Generac/Ring credentials, no network.
 *
 * Uses the same hermetic pattern as scripts/crypto-audit.test.mjs: "@/lib/db"
 * is aliased to an in-memory PGlite behind the repo's Sql interface, the real
 * migration SQL files (0002-0006) build the schema, and the DEK lives in a
 * temp dir so the repo's ./data/ is never touched.
 *
 * Coverage:
 *  - AES-256-GCM ciphertexts are bound to the org id (AAD): org B cannot
 *    decrypt org A's stored PWRview password or Ring refresh token.
 *  - Per-org isolation for PWRview credentials, Ring tokens, display / alert /
 *    TOU settings, energy history, and alerts.
 *  - Cross-org writes are denied at the data layer (acknowledgeAlert,
 *    credential/token reads).
 *  - Ring stream names are namespaced and disjoint per org.
 *  - deleteOrg removes the org and every owned row (cascade), leaves the
 *    other org intact, and keeps the append-only audit trail.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

// ---------------------------------------------------------------------------
// "@/lib/db" shim: in-memory PGlite behind the repo's Sql interface, plus a
// raw multi-statement exec for applying the real migration files.
// ---------------------------------------------------------------------------
const shimDir = mkdtempSync(join(tmpdir(), "phase2-isolation-"));
const shimPath = join(shimDir, "db-shim.mjs");
const shimSource = [
  "import { createRequire } from 'node:module';",
  `const require = createRequire(${JSON.stringify(join(repoRoot, "package.json"))});`,
  "const { PGlite } = require('@electric-sql/pglite');",
  "let pg = null;",
  "async function getPg() {",
  "  if (!pg) { pg = new PGlite(); await pg.waitReady; }",
  "  return pg;",
  "}",
  "function toSql(run, transact) {",
  "  const sql = async (strings, ...values) => {",
  "    let text = strings[0];",
  "    for (let i = 0; i < values.length; i++) text += '$' + (i + 1) + strings[i + 1];",
  "    return run(text, values);",
  "  };",
  "  sql.query = (text, params = []) => run(text, params);",
  "  sql.transaction = (fn) => transact(fn);",
  "  return sql;",
  "};",
  "const txRun = (ptx) => toSql(",
  "  async (text, params) => (await ptx.query(text, params)).rows,",
  "  (inner) => inner(txRun(ptx)),",
  ");",
  "export async function getSql() {",
  "  const db = await getPg();",
  "  return toSql(",
  "    async (text, params) => (await db.query(text, params)).rows,",
  "    async (fn) => db.transaction(async (ptx) => fn(txRun(ptx))),",
  "  );",
  "}",
  "export async function execAll(text) {",
  "  const db = await getPg();",
  "  await db.exec(text);",
  "}",
  "",
].join("\n");
writeFileSync(shimPath, shimSource);

const hookPath = join(shimDir, "alias-hook.mjs");
const hookSource = [
  "import { existsSync } from 'node:fs';",
  "import { pathToFileURL, fileURLToPath } from 'node:url';",
  "import { dirname, resolve as presolve } from 'node:path';",
  `const SRC = ${JSON.stringify(join(repoRoot, "src"))};`,
  "function tryExt(base) {",
  "  const cand = [base + '.ts', base + '.tsx', base + '/index.ts', base];",
  "  for (const c of cand) if (existsSync(c) && !c.endsWith('/')) return pathToFileURL(c).href;",
  "  return null;",
  "}",
  "export async function resolve(specifier, context, nextResolve) {",
  `  if (specifier === '@/lib/db') return { url: ${JSON.stringify(pathToFileURL(shimPath).href)}, shortCircuit: true };`,
  "  if (specifier.startsWith('@/')) {",
  "    const hit = tryExt(SRC + specifier.slice(1));",
  "    if (hit) return { url: hit, shortCircuit: true };",
  "  }",
  "  if (specifier.startsWith('./') || specifier.startsWith('../')) {",
  "    try {",
  "      const parent = fileURLToPath(context.parentURL);",
  "      const hit = tryExt(presolve(dirname(parent), specifier));",
  "      if (hit) return { url: hit, shortCircuit: true };",
  "    } catch {}",
  "  }",
  "  return nextResolve(specifier, context);",
  "}",
  "",
].join("\n");
writeFileSync(hookPath, hookSource);
register(pathToFileURL(hookPath).href);

// The DEK (credential encryption key) lives in a temp dir — never the repo.
const dekDir = mkdtempSync(join(tmpdir(), "phase2-isolation-dek-"));
process.env.DEK_FILE = join(dekDir, "dek.key");

// Real modules under test (Node strips types on import).
const creds = await import("../src/lib/pwrcell/org-credentials.server.ts");
const ringTokens = await import("../src/lib/ring/org-ring-tokens.server.ts");
const crypto = await import("../src/lib/authn/crypto.server.ts");
const orgSettings = await import("../src/lib/org-settings.server.ts");
const display = await import("../src/lib/display-settings.server.ts");
const tou = await import("../src/lib/tou-settings.server.ts");
const alerts = await import("../src/lib/alerts.server.ts");
const orgs = await import("../src/lib/orgs.server.ts");
const ringApi = await import("../src/lib/ring/ring-api.server.ts");
const shim = await import(pathToFileURL(shimPath).href);
const sql = await shim.getSql();

// Real schema: migrations 0002 (energy/alerts), 0003 (better-auth), 0004
// (tenant tables), 0005 (org on energy/alerts), 0006 (delete cascade).
for (const m of [
  "0002_energy_history.sql",
  "0003_auth_core.sql",
  "0004_auth_tenant.sql",
  "0005_energy_org.sql",
  "0006_org_delete_cascade.sql",
]) {
  await shim.execAll(readFileSync(join(repoRoot, "migrations", m), "utf8"));
}
// energy_samples/alerts -> organization FKs are added by the seed script in
// production; reproduce that contract step here.
await shim.execAll(`
  alter table energy_samples add constraint fk_energy_samples_org
    foreign key (organization_id) references organization(id) on delete cascade;
  alter table alerts add constraint fk_alerts_org
    foreign key (organization_id) references organization(id) on delete cascade;
`);

const ORG_A = "org_test_alpha";
const ORG_B = "org_test_beta";

async function seedOrg(id, name, slug) {
  await sql`insert into organization (id, name, slug, timezone, created_at)
    values (${id}, ${name}, ${slug}, 'America/Los_Angeles', now())`;
  await sql`insert into org_settings (org_id, settings) values (${id}, '{}'::jsonb)`;
}

await seedOrg(ORG_A, "Alpha Org", "alpha-org");
await seedOrg(ORG_B, "Beta Org", "beta-org");

// ---------------------------------------------------------------------------
// AES-256-GCM org + purpose binding (AAD = orgAad(orgId, purpose))
// ---------------------------------------------------------------------------

test("crypto: org A's ciphertext does not decrypt under org B", () => {
  const enc = crypto.encryptString("fixture-pwrview-password", crypto.orgAad(ORG_A, "pwrcell.password"));
  assert.throws(
    () => crypto.decryptString(enc.payload, enc.keyId, crypto.orgAad(ORG_B, "pwrcell.password")),
    /authentication error/,
    "org B must not decrypt org A's stored password",
  );
  // And the right org still can.
  assert.equal(
    crypto.decryptString(enc.payload, enc.keyId, crypto.orgAad(ORG_A, "pwrcell.password")),
    "fixture-pwrview-password",
  );
});

test("crypto: purpose is bound — a password blob is not a Ring token", () => {
  // Same org, different secret purpose: the AAD differs, so a ciphertext
  // swapped between the two columns (confused write or DB-level swap) fails
  // authentication instead of decrypting as the wrong secret (R2.3).
  const enc = crypto.encryptString("fixture-secret", crypto.orgAad(ORG_A, "pwrcell.password"));
  assert.throws(
    () => crypto.decryptString(enc.payload, enc.keyId, crypto.orgAad(ORG_A, "ring.refresh")),
    /authentication error/,
    "same-org ciphertext for another purpose must not decrypt",
  );
});

// ---------------------------------------------------------------------------
// PWRview credentials isolation
// ---------------------------------------------------------------------------

test("credentials: per-org isolation, no cross-org reads", async () => {
  await creds.setOrgCredentials(ORG_A, "alpha@example.com", "alpha-pass-1");
  const a = await creds.getOrgCredentials(ORG_A);
  assert.equal(a?.email, "alpha@example.com");
  assert.equal(a?.password, "alpha-pass-1");

  // Org B sees nothing of A's credentials.
  assert.equal(await creds.getOrgCredentials(ORG_B), null);
  assert.equal(await creds.orgCredentialsConfigured(ORG_B), false);
  assert.equal(await creds.getOrgCredentialEmail(ORG_B), null);
  const metaB = await creds.getOrgCredentialMeta(ORG_B);
  assert.equal(metaB.configured, false);
  assert.equal(metaB.email, null);

  // The stored row is ciphertext, not the password.
  const rows = await sql`select password_enc from org_credentials where org_id = ${ORG_A}`;
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].password_enc.includes("alpha-pass-1"), "password must be encrypted at rest");

  await creds.setOrgCredentials(ORG_B, "beta@example.com", "beta-pass-2");
  const b = await creds.getOrgCredentials(ORG_B);
  assert.equal(b?.password, "beta-pass-2");
  // A unchanged by B's write.
  assert.equal((await creds.getOrgCredentials(ORG_A))?.password, "alpha-pass-1");

  // Clearing B does not touch A.
  await creds.clearOrgCredentials(ORG_B);
  assert.equal(await creds.getOrgCredentials(ORG_B), null);
  assert.equal((await creds.getOrgCredentials(ORG_A))?.email, "alpha@example.com");
});

// ---------------------------------------------------------------------------
// Ring token isolation
// ---------------------------------------------------------------------------

test("ring tokens: per-org isolation", async () => {
  await ringTokens.setOrgRingToken(ORG_A, "ring-refresh-alpha");
  assert.equal(await ringTokens.getOrgRingToken(ORG_A), "ring-refresh-alpha");
  assert.equal(await ringTokens.getOrgRingToken(ORG_B), null);
  assert.equal(await ringTokens.orgRingConfigured(ORG_B), false);
  assert.equal(await ringTokens.orgRingConfigured(ORG_A), true);

  await ringTokens.setOrgRingToken(ORG_B, "ring-refresh-beta");
  assert.equal(await ringTokens.getOrgRingToken(ORG_B), "ring-refresh-beta");
  assert.equal(await ringTokens.getOrgRingToken(ORG_A), "ring-refresh-alpha");

  await ringTokens.clearOrgRingToken(ORG_A);
  assert.equal(await ringTokens.getOrgRingToken(ORG_A), null);
  assert.equal(await ringTokens.getOrgRingToken(ORG_B), "ring-refresh-beta");
  await ringTokens.clearOrgRingToken(ORG_B);
});

// ---------------------------------------------------------------------------
// Settings isolation (display / alerts / TOU)
// ---------------------------------------------------------------------------

test("settings: display/alerts/tou are per-org", async () => {
  await display.saveDisplaySettings(ORG_A, { theme: "light", backgroundColor: "#ffffff" });
  const a = await display.loadDisplaySettings(ORG_A);
  assert.equal(a.theme, "light");
  assert.equal(a.backgroundColor, "#ffffff");
  const b = await display.loadDisplaySettings(ORG_B);
  assert.equal(b.theme, "dark", "org B must see defaults, not org A's theme");
  assert.equal(b.backgroundColor, "#1a2f24");

  await tou.saveTouSettings(ORG_A, { summerPeak: 0.61, label: "Alpha rates" });
  const ta = await tou.loadTouSettings(ORG_A);
  assert.equal(ta.summerPeak, 0.61);
  assert.equal(ta.label, "Alpha rates");
  const tb = await tou.loadTouSettings(ORG_B);
  assert.notEqual(tb.summerPeak, 0.61, "org B must not inherit org A's rates");

  await alerts.saveAlertSettings(ORG_A, { enabled: false, lowSocThreshold: 5 });
  const sa = await alerts.loadAlertSettings(ORG_A);
  assert.equal(sa.enabled, false);
  assert.equal(sa.lowSocThreshold, 5);
  const sb = await alerts.loadAlertSettings(ORG_B);
  assert.equal(sb.enabled, true, "org B keeps its own alert settings");
});

// ---------------------------------------------------------------------------
// Ring stream namespacing
// ---------------------------------------------------------------------------

test("ring: stream names are namespaced and disjoint per org", () => {
  const a = ringApi.orgStreamNames(ORG_A);
  const b = ringApi.orgStreamNames(ORG_B);
  assert.deepEqual(a.length, 2);
  assert.deepEqual(b.length, 2);
  for (const name of a) {
    assert.ok(!b.includes(name), `stream ${name} must not belong to both orgs`);
    // Namespace is org_<16 hex of sha256(orgId)>__ — opaque, collision-free.
    assert.match(name, /^org_[0-9a-f]{16}__cam[12]$/, "stream name carries the hashed org namespace");
  }
  for (const name of b) {
    assert.match(name, /^org_[0-9a-f]{16}__cam[12]$/);
  }
  // A hostile org id cannot break out of the namespace or collide with a real org.
  const evil = ringApi.orgStreamNames("../../etc");
  for (const name of evil) {
    assert.match(name, /^org_[0-9a-f]{16}__cam[12]$/, "stream names are strict");
    assert.ok(!a.includes(name) && !b.includes(name), "hostile id must not collide with real orgs");
  }
  // Deterministic: same org id always maps to the same namespace.
  assert.deepEqual(ringApi.orgStreamNames(ORG_A), a, "namespace mapping is stable");
});

// ---------------------------------------------------------------------------
// Alerts + history isolation (data layer)
// ---------------------------------------------------------------------------

test("alerts: cross-org acknowledge is denied", async () => {
  const rows = await sql`
    insert into alerts (organization_id, rule, severity, message, acknowledged)
    values (${ORG_A}, 'low_soc', 'warn', 'alpha battery low', false)
    returning id`;
  const alertId = rows[0].id;

  // Org B cannot see or acknowledge org A's alert.
  assert.deepEqual(await alerts.getAlerts(ORG_B, 100), []);
  assert.deepEqual(await alerts.getUnacknowledged(ORG_B), []);
  await alerts.acknowledgeAlert(ORG_B, alertId);
  const still = await sql`select acknowledged from alerts where id = ${alertId}`;
  assert.equal(still[0].acknowledged, false, "cross-org ack must not flip the row");

  // Org A can.
  assert.equal((await alerts.getUnacknowledged(ORG_A)).length, 1);
  await alerts.acknowledgeAlert(ORG_A, alertId);
  assert.deepEqual(await alerts.getUnacknowledged(ORG_A), []);
});

test("history: org-scoped query returns only the org's rows", async () => {
  const now = Date.now();
  await sql`
    insert into energy_samples (organization_id, ts, solar_w, home_w)
    values (${ORG_A}, to_timestamp(${(now - 60000) / 1000.0}), 1000, 500),
           (${ORG_B}, to_timestamp(${(now - 60000) / 1000.0}), 9000, 9500)`;
  // Same shape as the /api/history route query.
  const rows = await sql.query(
    `select organization_id, avg(solar_w) as solar_w
     from energy_samples
     where organization_id = $1 and ts >= to_timestamp($2 / 1000.0)
     group by organization_id`,
    [ORG_A, now - 3600000],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].organization_id, ORG_A);
  assert.equal(Number(rows[0].solar_w), 1000);
});

// ---------------------------------------------------------------------------
// deleteOrg: complete cascade
// ---------------------------------------------------------------------------

test("deleteOrg: removes the org and everything it owns, keeps the other org", async () => {
  // Extra fixtures owned by A: member, invitation, kiosk + apikey, pairing code.
  await sql`insert into "user" (id, name, email, created_at, updated_at)
    values ('user_alpha', 'Alpha', 'alpha@example.com', now(), now())`;
  await sql`insert into member (id, organization_id, user_id, role, created_at)
    values ('mem_alpha', ${ORG_A}, 'user_alpha', 'owner', now())`;
  await sql`insert into invitation (id, organization_id, email, expires_at, created_at, inviter_id)
    values ('inv_alpha', ${ORG_A}, 'inv@example.com', now() + interval '1 day', now(), 'user_alpha')`;
  await sql`insert into apikey (id, reference_id, key, created_at, updated_at)
    values ('key_alpha', 'ref_alpha', 'secret_alpha', now(), now())`;
  await sql`insert into kiosk_devices (id, org_id, name, api_key_id, created_at)
    values ('kiosk_alpha', ${ORG_A}, 'wall', 'key_alpha', now())`;
  await sql`insert into pairing_codes (code_hash, org_id, expires_at, created_at)
    values ('hash_alpha', ${ORG_A}, now() + interval '10 minutes', now())`;

  // B gets a member too, to prove members of other orgs survive.
  await sql`insert into "user" (id, name, email, created_at, updated_at)
    values ('user_beta', 'Beta', 'beta@example.com', now(), now())`;
  await sql`insert into member (id, organization_id, user_id, role, created_at)
    values ('mem_beta', ${ORG_B}, 'user_beta', 'owner', now())`;

  const result = await orgs.deleteOrg(ORG_A, "user_alpha");
  assert.equal(result.deleted, "Alpha Org");

  const count = async (t, col = "organization_id") =>
    (await sql.query(`select count(*)::int as n from ${t} where ${col} = $1`, [ORG_A]))[0].n;
  assert.equal((await sql`select count(*)::int as n from organization where id = ${ORG_A}`)[0].n, 0);
  assert.equal(await count("member"), 0);
  assert.equal(await count("invitation"), 0);
  assert.equal(await count("org_settings", "org_id"), 0);
  assert.equal(await count("org_credentials", "org_id"), 0);
  assert.equal(await count("org_ring_tokens", "org_id"), 0);
  assert.equal(await count("energy_samples"), 0);
  assert.equal(await count("alerts"), 0);
  assert.equal(await count("kiosk_devices", "org_id"), 0);
  assert.equal(await count("pairing_codes", "org_id"), 0);
  // The kiosk's orphaned apikey row is cleaned up too.
  assert.equal((await sql`select count(*)::int as n from apikey where id = 'key_alpha'`)[0].n, 0);

  // The audit trail survives (append-only), including the deletion record.
  const auditRows = await sql`
    select action from audit_log where org_id = ${ORG_A} order by id desc limit 5`;
  assert.ok(auditRows.some((r) => r.action === "org.deleted"), "org.deleted must be audited");

  // Org B is completely intact.
  assert.equal((await sql`select count(*)::int as n from organization where id = ${ORG_B}`)[0].n, 1);
  assert.equal(await count("member"), 0); // helper is scoped to A; check B directly
  assert.equal((await sql`select count(*)::int as n from member where organization_id = ${ORG_B}`)[0].n, 1);
  assert.equal((await sql`select count(*)::int as n from energy_samples where organization_id = ${ORG_B}`)[0].n, 1);
  assert.equal((await display.loadDisplaySettings(ORG_B)).theme, "dark");

  // Deleting a missing org throws instead of silently succeeding.
  await assert.rejects(() => orgs.deleteOrg("org_nope"), /not found/);
});
