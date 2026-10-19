"use server";

// "Sync sekarang" from the status badge. A POST to a dashboard page, so
// proxy.ts's login check guards it like the page itself.

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { triggerSync } from "@/lib/trigger-sync";
import type { ActionResult } from "./actions";

export async function syncNow(): Promise<ActionResult> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (!host) return { ok: false, error: "Tidak bisa menentukan alamat aplikasi." };

  const result = await triggerSync(`${proto}://${host}`);
  revalidatePath("/", "layout");
  return "error" in result && result.error ? { ok: false, error: result.error } : { ok: true };
}
