// Persists OAuth tokens (and the short-lived PKCE state during the login
// handshake) across serverless invocations using Vercel KV. Also keeps the
// result of the last sync so the dashboard can show whether syncing works.
//
// Why KV and not an env var: COROS's OAuth 2.0 authorization server may
// rotate refresh tokens on each use (standard practice for public/DCR
// clients). A static env var can't absorb that rotation — KV can, because
// the callback/refresh code writes the newest token set back on every use.
//
// Setup: install the "Upstash Redis" storage integration (free tier) from
// the Vercel Marketplace on this project. It injects KV_REST_API_URL and
// KV_REST_API_TOKEN automatically — no extra config needed here. (The
// older "Vercel KV" product is deprecated in favor of this Marketplace
// integration; same underlying Upstash Redis, same env var names.)

import { Redis } from "@upstash/redis";
import type { SyncResult } from "./types";
import type { ActiveProgram } from "./coach";

const kv = Redis.fromEnv();

const TOKEN_KEY = "coros:oauth:tokens";
const CLIENT_KEY = "coros:oauth:client";
const PENDING_PREFIX = "coros:oauth:pending:"; // + state
const SYNC_STATUS_KEY = "coros:sync:last";
const ACTIVE_PROGRAM_KEY = "coach:program:active";
const DATA_FILE_PREFIX = "data:file:";
// Long enough for the sync commit to be deployed; after that the files in
// the deployment are current again and win.
const DATA_FILE_TTL_SECONDS = 6 * 60 * 60;

export interface CorosTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // unix ms
  tokenType: string;
  scope?: string;
}

export interface CorosClientRegistration {
  clientId: string;
  clientSecret?: string;
  registeredAt: number;
  /** The callback URL this client was registered with. Missing on old records. */
  redirectUri?: string;
}

export interface PendingAuth {
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

export async function saveTokens(tokens: CorosTokenSet): Promise<void> {
  await kv.set(TOKEN_KEY, tokens);
}

export async function loadTokens(): Promise<CorosTokenSet | null> {
  return (await kv.get<CorosTokenSet>(TOKEN_KEY)) ?? null;
}

export async function clearTokens(): Promise<void> {
  await kv.del(TOKEN_KEY);
}

export async function saveClientRegistration(
  reg: CorosClientRegistration
): Promise<void> {
  await kv.set(CLIENT_KEY, reg);
}

export async function loadClientRegistration(): Promise<CorosClientRegistration | null> {
  return (await kv.get<CorosClientRegistration>(CLIENT_KEY)) ?? null;
}

export async function savePendingAuth(
  state: string,
  pending: PendingAuth
): Promise<void> {
  // Expires in 10 minutes — the login round trip should never take longer.
  await kv.set(PENDING_PREFIX + state, pending, { ex: 600 });
}

export async function consumePendingAuth(
  state: string
): Promise<PendingAuth | null> {
  const key = PENDING_PREFIX + state;
  const value = await kv.get<PendingAuth>(key);
  if (value) await kv.del(key);
  return value ?? null;
}

export async function saveSyncStatus(result: SyncResult): Promise<void> {
  await kv.set(SYNC_STATUS_KEY, result);
}

export async function clearSyncStatus(): Promise<void> {
  await kv.del(SYNC_STATUS_KEY);
}

export async function loadSyncStatus(): Promise<SyncResult | null> {
  return (await kv.get<SyncResult>(SYNC_STATUS_KEY)) ?? null;
}

export async function saveActiveProgram(active: ActiveProgram): Promise<void> {
  await kv.set(ACTIVE_PROGRAM_KEY, active);
}

export async function loadActiveProgram(): Promise<ActiveProgram | null> {
  return (await kv.get<ActiveProgram>(ACTIVE_PROGRAM_KEY)) ?? null;
}

export async function clearActiveProgram(): Promise<void> {
  await kv.del(ACTIVE_PROGRAM_KEY);
}

/**
 * Fresh copies of the data files a sync just committed, so the dashboard
 * shows them right away instead of after Vercel redeploys the commit.
 */
export async function saveDataFiles(files: Record<string, unknown>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(([name, value]) =>
      kv.set(DATA_FILE_PREFIX + name, value, { ex: DATA_FILE_TTL_SECONDS })
    )
  );
}

export async function loadDataFile<T>(name: string): Promise<T | null> {
  return (await kv.get<T>(DATA_FILE_PREFIX + name)) ?? null;
}

export function isStorageConfigured(): boolean {
  return !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
}

export interface DashboardStatus {
  /** "not-configured": no Redis env vars (e.g. local dev without .env.local) */
  storage: "ok" | "not-configured" | "unreachable";
  corosConnected: boolean;
  lastSync: SyncResult | null;
  activeProgram: ActiveProgram | null;
}

export async function loadDashboardStatus(): Promise<DashboardStatus> {
  const empty = { corosConnected: false, lastSync: null, activeProgram: null };
  if (!isStorageConfigured()) return { storage: "not-configured", ...empty };
  try {
    const [tokens, lastSync, activeProgram] = await Promise.all([
      loadTokens(),
      loadSyncStatus(),
      loadActiveProgram(),
    ]);
    return { storage: "ok", corosConnected: !!tokens, lastSync, activeProgram };
  } catch (err) {
    console.error("Failed to load dashboard status:", err);
    return { storage: "unreachable", ...empty };
  }
}
