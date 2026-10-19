// Thin wrapper that opens one authenticated MCP session against
// https://mcp.coros.com/mcp and calls its tools (querySportRecords,
// queryFitnessAssessmentOverview, queryTrainingLoadAssessment,
// queryRestingHeartRate, querySleepOverview, queryStressLevel).
//
// One session per sync on purpose: each session used to check the token on
// its own, so an expired token was refreshed several times in parallel with
// the same refresh token. When the server rotates refresh tokens, all but
// one of those refreshes are rejected and the stored token can end up
// revoked, which disconnects COROS until someone re-authorizes.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { COROS_MCP_URL, refreshTokens } from "./coros-oauth";
import { loadTokens, saveTokens, type CorosTokenSet } from "./token-store";

async function getValidAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens) {
    throw new Error(
      "No COROS tokens stored yet — visit /api/coros/authorize once to complete the OAuth consent."
    );
  }

  const expiresInMs = tokens.expiresAt - Date.now();
  if (expiresInMs > 60_000) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    throw new Error(
      "COROS access token expired and no refresh token is stored — re-authorize via /api/coros/authorize."
    );
  }

  const refreshed = await refreshTokens(tokens.refreshToken);
  const newTokens: CorosTokenSet = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    tokenType: refreshed.token_type,
    scope: refreshed.scope,
  };
  await saveTokens(newTokens);
  return newTokens.accessToken;
}

export interface CorosSession {
  call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

export async function withCorosSession<T>(
  fn: (session: CorosSession) => Promise<T>
): Promise<T> {
  const accessToken = await getValidAccessToken();

  const transport = new StreamableHTTPClientTransport(new URL(COROS_MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });

  const client = new Client({ name: "coros-running-dashboard", version: "0.1.0" });
  await client.connect(transport);

  const session: CorosSession = {
    async call<R>(name: string, args: Record<string, unknown>): Promise<R> {
      const result = await client.callTool({ name, arguments: args });
      // MCP tool results come back as content blocks; COROS's tools return a
      // single human-readable text block.
      const content = (result as any).content;
      const firstText = Array.isArray(content)
        ? content.find((c: any) => c.type === "text")?.text
        : undefined;
      if ((result as any).isError) {
        throw new Error(`COROS tool ${name} gagal: ${firstText ?? "tanpa pesan"}`);
      }
      if (!firstText) return result as R;
      try {
        return JSON.parse(firstText) as R;
      } catch {
        return firstText as R;
      }
    },
  };

  try {
    return await fn(session);
  } finally {
    await client.close();
  }
}
