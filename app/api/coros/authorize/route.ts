// Step 1 of the OAuth handshake: redirect the user to COROS's consent
// screen. Visit /api/coros/authorize once after deploying (and again any
// time you see "no refresh token stored" in the cron logs).

import { NextRequest, NextResponse } from "next/server";
import {
  buildAuthorizationUrl,
  generatePkcePair,
  generateState,
} from "@/lib/coros-oauth";
import { savePendingAuth } from "@/lib/token-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Come back to the domain the user started from, so a renamed or extra
  // Vercel domain works without touching env vars.
  const redirectUri = `${req.nextUrl.origin}/api/coros/callback`;

  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = generateState();

  await savePendingAuth(state, {
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  });

  try {
    const authUrl = await buildAuthorizationUrl({
      redirectUri,
      state,
      codeChallenge,
    });
    return NextResponse.redirect(authUrl);
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to start COROS OAuth flow", detail: err.message },
      { status: 500 }
    );
  }
}
