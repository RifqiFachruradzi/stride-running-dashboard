"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncNow } from "@/app/sync-actions";

export function SyncNowButton() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await syncNow();
            if (!res.ok) setError(res.error);
            router.refresh();
          })
        }
        className="link font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-70"
        style={{ color: "var(--text-primary)" }}
      >
        {pending ? "Menyinkronkan…" : "Sync sekarang"}
      </button>
      {error && <span className="sr-only" role="status">{error}</span>}
    </>
  );
}
