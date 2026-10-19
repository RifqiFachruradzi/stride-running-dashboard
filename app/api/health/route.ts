// Quick status check: are tokens stored, are the required env vars set.
// Visit /api/health after deploying to confirm setup before waiting for cron.

import { NextResponse } from "next/server";
import { loadTokens } from "@/lib/token-store";
import { checkGitHubAccess } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function GET() {
  const [tokens, github] = await Promise.all([loadTokens(), checkGitHubAccess()]);

  return NextResponse.json({
    corosAuthorized: !!tokens,
    corosTokenExpiresAt: tokens ? new Date(tokens.expiresAt).toISOString() : null,
    github,
    envConfigured: {
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      GITHUB_OWNER: !!process.env.GITHUB_OWNER,
      GITHUB_REPO: !!process.env.GITHUB_REPO,
      GITHUB_BRANCH: !!process.env.GITHUB_BRANCH,
      CRON_SECRET: !!process.env.CRON_SECRET,
      DASHBOARD_EMAIL: !!process.env.DASHBOARD_EMAIL,
      DASHBOARD_PASSWORD: !!process.env.DASHBOARD_PASSWORD,
      AUTH_SECRET: !!process.env.AUTH_SECRET,
      COACH_LLM_BASE_URL: !!process.env.COACH_LLM_BASE_URL,
      COACH_LLM_API_KEY: !!process.env.COACH_LLM_API_KEY,
      COACH_LLM_MODEL: !!process.env.COACH_LLM_MODEL,
      KV: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
    },
  });
}
