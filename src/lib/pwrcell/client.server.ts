import { env } from "@/lib/env.server";
import { getCredentials } from "./credentials.server";

const CLIENT_ID = "1im6pfcmq8oo8db7usd8kjrgkk";
const CLIENT_SECRET = "bpbuhh5u8atmuekq4rh4l8bhnig5cqd2el66tkfmp60gs3sd62f";
const APP_HEADERS: Record<string, string> = {
  "user-agent": "GeneracHome/38904 CFNetwork/3860.400.51 Darwin/25.3.0",
  mobileappversion: "1.30.0",
  mobileappbuildnumber: "38904",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
};

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
}

export function apiBase(): string {
  return (env("GENERAC_API_BASE") ?? "https://generac-api.neur.io").replace(/\/$/, "");
}

export function hasCredentials(): boolean {
  return getCredentials() !== null;
}

function readJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 240) };
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    for (const key of ["message", "error", "errorMessage", "detail"]) {
      if (typeof rec[key] === "string" && rec[key]) return rec[key] as string;
    }
    try {
      const s = JSON.stringify(body);
      if (s && s.length > 2) return s.slice(0, 240);
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

/** Strip the API base and query params from a request URL for logging. */
function logPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname || url;
  } catch {
    return url;
  }
}

export class GeneracClient {
  private accessToken: string | null = null;
  private idToken: string | null = null;
  private refreshToken: string | null = null;
  private userId: string | null = null;
  private expiresAt = 0;
  private inflightAuth: Promise<string> | null = null;
  upstreamCalls = 0;

  get tokenValid(): boolean {
    return Boolean(this.idToken) && Date.now() < this.expiresAt - REFRESH_BUFFER_MS;
  }

  clearTokens(): void {
    this.accessToken = null;
    this.idToken = null;
    this.refreshToken = null;
    this.userId = null;
    this.expiresAt = 0;
  }

  async fetchHomes(): Promise<unknown> {
    return this.authedGet(`${apiBase()}/live/v1/homes`);
  }

  async fetchTelemetry(homeId: string, fromIso: string): Promise<unknown> {
    const url = `${apiBase()}/live/v2/homes/${encodeURIComponent(homeId)}/telemetry?fromIso=${encodeURIComponent(fromIso)}`;
    return this.authedGet(url);
  }

  private async authedGet(url: string, retried = false): Promise<unknown> {
    const token = await this.ensureIdToken();
    const res = await this.rawFetch(url, {
      method: "GET",
      headers: { ...APP_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && !retried) {
      this.clearTokens();
      await this.signIn();
      return this.authedGet(url, true);
    }
    const text = await res.text();
    const body = readJson(text);
    if (!res.ok) {
      throw new AuthError(
        `Generac ${logPath(url)} → ${res.status}: ${errorMessage(body, "request failed")}`,
        res.status,
      );
    }
    return body;
  }

  private async ensureIdToken(): Promise<string> {
    if (this.tokenValid && this.idToken) return this.idToken;
    if (this.inflightAuth) return this.inflightAuth;
    this.inflightAuth = this.authenticate().finally(() => {
      this.inflightAuth = null;
    });
    return this.inflightAuth;
  }

  private async authenticate(): Promise<string> {
    if (this.refreshToken && this.userId) {
      try {
        await this.refresh();
        if (!this.idToken) throw new AuthError("Refresh returned no id_token");
        return this.idToken;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[pwrcell] token refresh failed, signing in again:", msg);
      }
    }
    await this.signIn();
    if (!this.idToken) throw new AuthError("Sign-in returned no id_token");
    return this.idToken;
  }

  private async signIn(): Promise<void> {
    const creds = getCredentials();
    const email = creds?.email;
    const password = creds?.password;
    if (!email || !password) {
      throw new AuthError("GENERAC_EMAIL and GENERAC_PASSWORD are not set");
    }
    const res = await this.rawFetch(`${apiBase()}/sessions/v1/signin`, {
      method: "POST",
      headers: { ...APP_HEADERS, Authorization: basicAuthHeader() },
      body: JSON.stringify({ email, password }),
    });
    const body = readJson(await res.text());
    if (!res.ok) {
      throw new AuthError(
        `Generac ${logPath(`${apiBase()}/sessions/v1/signin`)} → ${res.status}: ${errorMessage(body, "sign-in failed")}`,
        res.status,
      );
    }
    this.storeTokens(body);
  }

  private async refresh(): Promise<void> {
    const res = await this.rawFetch(`${apiBase()}/sessions/v2/refresh/token`, {
      method: "POST",
      headers: { ...APP_HEADERS },
      body: JSON.stringify({
        userId: this.userId,
        refreshToken: this.refreshToken,
      }),
    });
    const body = readJson(await res.text());
    if (!res.ok) {
      throw new AuthError(
        `Generac ${logPath(`${apiBase()}/sessions/v2/refresh/token`)} → ${res.status}: ${errorMessage(body, "token refresh failed")}`,
        res.status,
      );
    }
    this.storeTokens(body);
  }

  private storeTokens(body: unknown): void {
    const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const idToken = typeof rec.id_token === "string" ? rec.id_token : null;
    const accessToken = typeof rec.access_token === "string" ? rec.access_token : null;
    const refreshToken = typeof rec.refresh_token === "string" ? rec.refresh_token : null;
    const userId = typeof rec.user_id === "string" ? rec.user_id : this.userId;
    const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : 3600;
    if (!idToken) throw new AuthError("Auth response missing id_token");
    this.idToken = idToken;
    this.accessToken = accessToken;
    if (refreshToken) this.refreshToken = refreshToken;
    this.userId = userId;
    this.expiresAt = Date.now() + expiresIn * 1000;
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    this.upstreamCalls += 1;
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AuthError(`Network error: ${msg}`);
    }
  }
}

export const generac = new GeneracClient();
