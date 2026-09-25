import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env.server";

/**
 * PWRview credential store.
 *
 * Reads GENERAC_EMAIL / GENERAC_PASSWORD from (in order):
 *   1. ./dashboard.env (written by setup.ps1 or the in-app login menu)
 *   2. process.env (set by start-dashboard.ps1 / the shell / a VPS deploy)
 *
 * The file wins because it is the source the login menu manages: the
 * launcher copies it into the process environment at startup, so reading
 * the process first would make in-app credential changes silently ignored
 * until the next restart.
 *
 * The login menu writes back to dashboard.env so credentials survive
 * restarts. The password is NEVER exposed through any API response.
 */
const ENV_FILE = path.resolve(process.cwd(), "dashboard.env");

function readEnvFile(): Record<string, string> {
  try {
    const raw = fs.readFileSync(ENV_FILE, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      out[m[1]] = unquote(m[2]);
    }
    return out;
  } catch {
    return {};
  }
}

/** Values are stored JSON-quoted so leading/trailing spaces, quotes,
 *  backslashes and newlines in passwords survive the round-trip. */
function quote(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      /* fall through to raw */
    }
  }
  return value.trim();
}

function writeEnvFile(vars: Record<string, string>): void {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${quote(v)}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf8");
}

export function getCredentials(): { email: string; password: string } | null {
  const file = readEnvFile();
  const email = (file["GENERAC_EMAIL"] ?? env("GENERAC_EMAIL") ?? "").trim();
  const password = file["GENERAC_PASSWORD"] ?? env("GENERAC_PASSWORD") ?? "";
  return email && password ? { email, password } : null;
}

/** Safe for API responses: never includes the password. */
export function getCredentialMeta(): { configured: boolean; email: string | null } {
  const c = getCredentials();
  return { configured: c !== null, email: c?.email ?? null };
}

export function setCredentials(email: string, password: string): void {
  const file = readEnvFile();
  file["GENERAC_EMAIL"] = email.trim();
  file["GENERAC_PASSWORD"] = password;
  writeEnvFile(file);
}

export function clearCredentials(): void {
  const file = readEnvFile();
  delete file["GENERAC_EMAIL"];
  delete file["GENERAC_PASSWORD"];
  writeEnvFile(file);
  // The launcher copies dashboard.env into the process environment at startup,
  // so without this an env-supplied login would survive the disconnect.
  delete process.env.GENERAC_EMAIL;
  delete process.env.GENERAC_PASSWORD;
}
