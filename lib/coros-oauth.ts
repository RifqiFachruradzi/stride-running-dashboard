// OAuth 2.0 handshake against the COROS MCP server, following the flow COROS
// documents ("Build on COROS MCP" — self-serve, no manual application):
//   1. Discover the authorization server via RFC 8414 metadata
//      (/.well-known/oauth-authorization-server on the MCP origin).
//   2. Register this app as an OAuth client via RFC 7591 Dynamic Client
//      Registration (self-serve — no approval step).
//   3. Run a standard Authorization Code + PKCE (RFC 7636) flow.
//
// NOTE: COROS's public docs confirm the server URL and that "no application
// or approval required" / "any OAuth 2.0 client library works" — they do not
// publish the exact discovery/DCR endpoint paths in the article we could
// read. This module follows the MCP Authorization spec's mandated discovery
// + DCR flow, which is the standard a compliant MCP OAuth server implements.
// If COROS's server deviates (e.g. fixed client_id instead of DCR), you'll
// see a 404 on the discovery call below — check the response body it logs
// and adjust CORS_AUTH_SERVER_METADATA_URL / registerClient() accordingly.

import { randomBytes, createHash } from "crypto";
import {
  loadClientRegistration,
  saveClientRegistration,
  type CorosClientRegistration,
} from "./token-store";

export const COROS_MCP_URL = "https://mcp.coros.com/mcp";
const COROS_ORIGIN = "https://mcp.coros.com";

interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

let metadataCache: AuthServerMetadata | null = null;

export async function discoverAuthServerMetadata(): Promise<AuthServerMetadata> {
  if (metadataCache) return metadataCache;

  const wellKnownUrl = `${COROS_ORIGIN}/.well-known/oauth-authorization-server`;
  const res = await fetch(wellKnownUrl);
  if (!res.ok) {
    throw new Error(
      `COROS OAuth discovery failed at ${wellKnownUrl}: ${res.status} ${await res.text()}`
    );
  }
  metadataCache = (await res.json()) as AuthServerMetadata;
  return metadataCache;
}

export async function ensureClientRegistration(
  redirectUri: string
): Promise<CorosClientRegistration> {
  // COROS only redirects to the callback URL a client was registered with, so
  // a new domain (e.g. after renaming the Vercel project) needs a new client.
  const existing = await loadClientRegistration();
  if (existing && existing.redirectUri === redirectUri) return existing;

  const metadata = await discoverAuthServerMetadata();
  if (!metadata.registration_endpoint) {
    throw new Error(
      "COROS auth server did not advertise a registration_endpoint — " +
        "dynamic client registration may not be supported. Check " +
        "support.coros.com 'Build on COROS MCP' for a manual client_id."
    );
  }

  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Coros Running Dashboard",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client (PKCE-only)
    }),
  });

  if (!res.ok) {
    throw new Error(
      `COROS dynamic client registration failed: ${res.status} ${await res.text()}`
    );
  }

  const body = await res.json();
  const registration: CorosClientRegistration = {
    clientId: body.client_id,
    clientSecret: body.client_secret,
    registeredAt: Date.now(),
    redirectUri,
  };
  await saveClientRegistration(registration);
  return registration;
}

export function generatePkcePair() {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export async function buildAuthorizationUrl(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): Promise<string> {
  const metadata = await discoverAuthServerMetadata();
  const client = await ensureClientRegistration(params.redirectUri);

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Adjust if COROS documents a narrower/wider scope list.
  // url.searchParams.set("scope", "offline_access read:activities read:health");
  url.searchParams.set("scope", "openid mcp.tools offline_access");
  return url.toString();
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  const metadata = await discoverAuthServerMetadata();
  const client = await ensureClientRegistration(params.redirectUri);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: client.clientId,
    code_verifier: params.codeVerifier,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `COROS token exchange failed: ${res.status} ${await res.text()}`
    );
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
}

export async function refreshTokens(refreshToken: string) {
  const metadata = await discoverAuthServerMetadata();
  // The refresh token belongs to the client that obtained it, so never
  // register a new one here.
  const client = await loadClientRegistration();
  if (!client) {
    throw new Error("No COROS client registration stored — re-authorize via /api/coros/authorize.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);

  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `COROS token refresh failed: ${res.status} ${await res.text()}`
    );
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
    scope?: string;
  };
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
