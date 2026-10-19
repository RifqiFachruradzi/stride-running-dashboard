"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncNow } from "@/app/sync-actions";
import { Icon } from "@/components/icons";

export function SyncNowButton() {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setNote(null);
            const res = await syncNow();
            setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: "Sync gagal" });
            router.refresh();
          })
        }
        className="icon-button h-10 w-10 rounded-full disabled:cursor-wait"
        style={{ background: "var(--surface-1)", color: "var(--text-primary)" }}
        aria-label={pending ? "Menyinkronkan" : "Sync sekarang"}
        title="Sync sekarang"
      >
        <span className={pending ? "animate-spin" : undefined} style={{ display: "inline-flex" }}>
          <Icon name="sync" size={18} />
        </span>
      </button>
      {note && !pending && (
        <span role="status" className="text-xs" style={{ color: note.ok ? "var(--blue-text)" : "var(--pink-text)" }}>
          {note.text}
        </span>
      )}
    </div>
  );
}
