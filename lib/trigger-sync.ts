// Runs the sync job on demand by calling our own cron endpoint with the cron
// secret, so manual syncs go through exactly the same code as the daily one.

import type { SyncResult } from "./types";

export async function triggerSync(origin: string): Promise<SyncResult | { error: string }> {
  try {
    const res = await fetch(`${origin}/api/cron/sync`, {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    if (!body) return { error: `Sync gagal (${res.status}).` };
    return body;
  } catch (err: any) {
    return { error: err.message ?? "Sync gagal." };
  }
}
