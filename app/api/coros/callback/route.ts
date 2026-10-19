// Step 2 of the OAuth handshake: COROS redirects back here with ?code&state.
// Exchanges the code for tokens, stores them in KV for the cron job, then
// starts a sync right away and sends the user back to the dashboard.

import { after, NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/coros-oauth";
import { triggerSync } from "@/lib/trigger-sync";
import { clearSyncStatus, consumePendingAuth, saveTokens } from "@/lib/token-store";

export const dynamic = "force-dynamic";
// Room for the sync that runs after the response.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const errorParam = req.nextUrl.searchParams.get("error");

  if (errorParam) {
    return NextResponse.json(
      { error: "COROS returned an OAuth error", detail: errorParam },
      { status: 400 }
    );
  }
  if (!code || !state) {
    return NextResponse.json(
      { error: "Missing code or state in callback." },
      { status: 400 }
    );
  }

  const pending = await consumePendingAuth(state);
  if (!pending) {
    return NextResponse.json(
      { error: "Unknown or expired state — restart at /api/coros/authorize." },
      { status: 400 }
    );
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    });

    await saveTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      tokenType: tokens.token_type,
      scope: tokens.scope,
    });

    // The stored status still holds the failure that asked for this
    // reconnect; drop it so the badge stops offering "Hubungkan".
    await clearSyncStatus();

    // Sync now instead of waiting for tomorrow's cron. It runs after the
    // redirect, so the user isn't kept waiting.
    const origin = req.nextUrl.origin;
    after(async () => {
      const result = await triggerSync(origin);
      if ("error" in result && result.error) console.error("Sync after connect failed:", result.error);
    });

    return NextResponse.redirect(new URL("/", origin));
  } catch (err: any) {
    return NextResponse.json(
      { error: "Token exchange failed", detail: err.message },
      { status: 500 }
    );
  }
}
