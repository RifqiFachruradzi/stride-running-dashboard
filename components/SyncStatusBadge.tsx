import { formatDistanceToNow } from "date-fns";
import { id } from "date-fns/locale";
import type { DashboardStatus } from "@/lib/token-store";

// The cron runs daily, and the Hobby plan may shift it by up to an hour.
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

type Tone = "good" | "warning" | "critical" | "neutral";

const TONE_COLOR: Record<Tone, string> = {
  good: "var(--blue)",
  warning: "var(--yellow)",
  critical: "var(--pink)",
  neutral: "var(--text-muted)",
};

function describe(status: DashboardStatus): {
  tone: Tone;
  text: string;
  detail?: string;
  reconnect?: boolean;
} {
  if (status.storage === "not-configured") {
    return {
      tone: "neutral",
      text: "Status sync tidak tersedia",
      detail: "Redis belum dikonfigurasi (KV_REST_API_URL / UPSTASH_REDIS_REST_URL kosong).",
    };
  }
  if (status.storage === "unreachable") {
    return {
      tone: "critical",
      text: "Status sync tidak tersedia",
      detail: "Redis tidak bisa diakses — cek token Upstash dan function logs Vercel.",
    };
  }
  if (!status.corosConnected) {
    return { tone: "warning", text: "COROS belum terhubung", reconnect: true };
  }

  const last = status.lastSync;
  if (!last) return { tone: "warning", text: "Terhubung · menunggu sync pertama" };

  const ago = formatDistanceToNow(new Date(last.syncedAt), { addSuffix: true, locale: id });
  if (last.error) {
    return {
      tone: "critical",
      text: `Sync gagal ${ago}`,
      detail: last.error,
      reconnect: /authoriz|refresh/i.test(last.error),
    };
  }
  if (Date.now() - new Date(last.syncedAt).getTime() > STALE_AFTER_MS) {
    return { tone: "warning", text: `Sync terakhir ${ago}` };
  }
  const added = last.newActivities > 0 ? ` · +${last.newActivities} lari` : "";
  return { tone: "good", text: `Sync terakhir ${ago}${added}` };
}

export function SyncStatusBadge({ status }: { status: DashboardStatus }) {
  const { tone, text, detail, reconnect } = describe(status);

  return (
    <div className="flex min-w-0 flex-col items-start gap-1 sm:items-end">
      <div className="pill min-h-[40px] px-4 font-medium" style={{ background: "var(--surface-1)", color: "var(--text-secondary)" }}>
        <span aria-hidden className="dot" style={{ background: TONE_COLOR[tone] }} />
        <span>{text}</span>
        {reconnect && (
          <a
            href="/api/coros/authorize"
            className="link font-semibold underline underline-offset-2"
            style={{ color: "var(--text-primary)" }}
          >
            Hubungkan
          </a>
        )}
      </div>
      {detail && (
        <p className="max-w-xs break-words text-xs sm:text-right" style={{ color: "var(--text-secondary)" }}>
          {detail}
        </p>
      )}
    </div>
  );
}
