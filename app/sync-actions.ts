"use server";

// The "Sync" button in the dashboard header. A POST to a dashboard page, so
// proxy.ts's login check guards it like the page itself.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { triggerSync } from "@/lib/trigger-sync";

export type SyncNowResult = { ok: true; message: string } | { ok: false; error: string };

export async function syncNow(): Promise<SyncNowResult> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (!host) return { ok: false, error: "Tidak bisa menentukan alamat aplikasi." };

  const result = await triggerSync(`${proto}://${host}`);
  revalidatePath("/", "layout");
  if ("error" in result && result.error) return { ok: false, error: result.error };

  const added = "newActivities" in result ? result.newActivities : 0;
  return {
    ok: true,
    message: added > 0 ? `+${added} lari baru masuk` : "Sudah paling baru",
  };
}
