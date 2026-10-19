# STRIDE+ — dashboard lari COROS

Dashboard progress lari personal: menarik data lari, fitness assessment,
training load, dan kondisi tubuh (resting HR, sleep, stress) langsung dari
akun COROS lewat OAuth 2.0, disimpan sebagai JSON versioned di repo ini, dan
otomatis sinkron via Vercel Cron.

## Arsitektur singkat

- **Frontend**: Next.js App Router, komponen chart dengan Recharts, styling
  Tailwind mengikuti skema warna data-viz (lihat `app/globals.css`).
- **Backend**: API routes Next.js di Vercel — OAuth handshake ke COROS MCP
  (`/api/coros/authorize`, `/api/coros/callback`) dan job sinkronisasi
  (`/api/cron/sync`) yang dipanggil Vercel Cron.
- **Data**: file JSON di `/data` — sumber kebenaran tunggal, ter-versioning
  lewat commit history GitHub. Cron job hanya commit kalau ada data baru.
- **Auth ke COROS**: OAuth 2.0 self-serve langsung ke
  `https://mcp.coros.com/mcp` (tidak lewat Claude) — lihat catatan penting
  di bawah.

## Setup

### 1. Import ke Vercel

Import repo ini sebagai project baru di [vercel.com](https://vercel.com/new).

### 2. Aktifkan penyimpanan Upstash Redis

Di tab **Storage** project ini (Vercel Marketplace), tambahkan integrasi
**Upstash Redis** (ada tier gratis). Ini otomatis menambahkan env var
`KV_REST_API_URL` dan `KV_REST_API_TOKEN` — dipakai untuk menyimpan token
OAuth COROS antar invocation serverless (produk lama "Vercel KV" sudah
deprecated, diganti integrasi Marketplace ini dengan nama env var yang sama).

### 3. Set environment variables

Salin dari `.env.example` ke **Settings → Environment Variables**:

| Var | Keterangan |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT, scope hanya repo ini, permission "Contents: Read and write". **Beda dari koneksi GitHub di chat Claude** — token ini dipakai backend yang jalan mandiri di Vercel. |
| `GITHUB_OWNER` | `RifqiFachruradzi` |
| `GITHUB_REPO` | nama repo ini |
| `GITHUB_BRANCH` | `main` |
| `CRON_SECRET` | **wajib** — string acak bebas. Vercel otomatis mengirim ini sebagai header saat memanggil cron. Tanpa ini, `/api/cron/sync` menolak semua request di production. |
| `DASHBOARD_EMAIL` | email untuk login ke dashboard |
| `DASHBOARD_PASSWORD` | disarankan — password login dashboard (halaman `/login`). **Wajib** — di production dashboard terkunci sampai ini diisi. Jangan tulis di kode: repo ini publik. |
| `AUTH_SECRET` | disarankan — string acak panjang untuk menandatangani cookie sesi. Mengganti password atau nilai ini membuat semua sesi logout. |
| `WEEKLY_TARGET_KM` | opsional — target jarak mingguan dalam km (default `20`) |

Redeploy setelah menambahkan env vars.

### 4. Hubungkan akun COROS (sekali saja)

Buka `https://<domain-vercel-kamu>/api/coros/authorize`, login & setujui
akses COROS-mu. Setelah redirect balik sukses, token tersimpan di KV dan
cron job bisa mulai narik data.

Cek status kapan saja lewat `/api/health`.

### 5. Trigger sync pertama (opsional, tidak perlu tunggu jadwal)

```
curl https://<domain-vercel-kamu>/api/cron/sync \
  -H "Authorization: Bearer <CRON_SECRET>"
```

## Jadwal sinkronisasi

`vercel.json` men-set cron **sekali sehari** (`0 15 * * *` UTC ≈ 22:00 WIB).

> **Penting soal frekuensi**: paket **Vercel Hobby (gratis) membatasi cron
> maksimal 1x/hari**, dengan presisi ±59 menit. Untuk polling lebih sering
> (tiap 15–30 menit, lebih mendekati "real-time"), perlu upgrade ke
> [Vercel Pro](https://vercel.com/docs/plans/pro-plan) (mendukung interval
> per-menit). Ubah `schedule` di `vercel.json` sesuai kebutuhan setelah
> upgrade.

## Fitur

Semua halaman ada di sidebar pink:

| Halaman | Isi |
|---|---|
| `/` Ringkasan | Volume mingguan, latihan besok, lari terakhir, target, program, tren, rekor, kondisi tubuh |
| `/riwayat` | Kalender heatmap per bulan, total 12 bulan dan per tahun, semua lari |
| `/aktivitas/[id]` | Analisis satu lari: pace dan HR dibanding 30 hari terakhir, efisiensi aerobik (meter per detak), peringkat di antara lari berjarak serupa, training load dan kondisi tubuh hari itu, tombol tanya Coach |
| `/target` | Target jarak mingguan/bulanan/tahunan, jumlah lari per minggu, dan target race (waktu + tanggal, diprediksi dengan rumus Riegel). Status tercapai / sesuai jadwal / tertinggal |
| `/rekor` | Rekor jarak, waktu, pace, minggu/bulan terjauh, streak, dan riwayat kapan setiap rekor dipecahkan |
| `/chat` | Chat dengan Coach |

Target disimpan di Upstash Redis yang sama dengan token COROS (`user:goals`).
Tanpa Redis, halamannya tetap tampil tapi tidak bisa menyimpan. Target jarak mingguan juga menggantikan `WEEKLY_TARGET_KM` di
dashboard saat tidak ada program aktif, dan semua target ikut dibaca Coach di
chat.

COROS hanya mengirim ringkasan per lari (tanpa GPS dan split), jadi rekor
jarak dihitung dari pace rata-rata.

## Pasang sebagai aplikasi di HP (PWA)

STRIDE+ bisa dipasang ke layar utama dan terbuka layar penuh seperti
aplikasi biasa, tanpa App Store:

- **iPhone (Safari)**: buka domain Vercel-mu → tombol **Share** → **Add to
  Home Screen** → **Add**. Buka STRIDE+ dari ikon petir S, lalu login sekali
  (sesi berlaku 30 hari).
- **Android (Chrome)**: menu ⋮ → **Install app**.

Manifest ada di `app/manifest.ts`, ikon di `app/apple-icon.png` dan
`public/icons/`. Service worker (`public/sw.js`) sengaja tidak menyimpan
halaman apa pun karena berisi data pribadi; ia hanya menampilkan
`public/offline.html` saat tidak ada koneksi. File-file itu dikecualikan dari
login di `proxy.ts` supaya HP bisa memasang aplikasinya.

## Pelatih AI (rekomendasi & program latihan)

Setiap malam (16:30 UTC ≈ 23:30 WIB, setelah cron sync) Vercel Cron
memanggil `/api/cron/coach`. Route ini membaca `/data` dan program aktif di
Redis, lalu meminta rekomendasi ke model di **9Router** (proxy LLM di VPS
sendiri, endpoint kompatibel OpenAI). Hasilnya divalidasi dengan
`lib/coach.ts`. Kalau tidak lolos, error dikirim balik ke model, maksimal 3
percobaan. Setelah lolos, hasilnya di-commit ke `data/recommendation.json`.
Isinya: status kesiapan, latihan untuk besok, dan 2–3 tawaran program
(misalnya "6K Goals Routine" atau "10K Routine"). Prompt-nya ada di
`lib/coach-llm.ts`.

Env var yang dibutuhkan:

| Var | Keterangan |
|---|---|
| `COACH_LLM_BASE_URL` | URL endpoint 9Router, diakhiri `/v1` |
| `COACH_LLM_API_KEY` | API key dari halaman "Endpoint & Key" 9Router |
| `COACH_LLM_MODEL` | nama model atau combo di 9Router |

Tes manual:

```
curl https://<domain-vercel-kamu>/api/cron/coach \
  -H "Authorization: Bearer <CRON_SECRET>"
```

### Chat dengan Coach

Halaman `/chat` (ikon chat di sidebar) memakai 9Router
yang sama. Server menambahkan data latihan terbaru, program aktif, dan
rekomendasi hari ini ke setiap pertanyaan, lalu jawaban di-stream ke browser.
Riwayat chat disimpan di browser. Set `COACH_CHAT_MODEL` kalau chat mau
memakai model lain dari rekomendasi harian.

Alternatif tanpa 9Router: routine Claude Code terjadwal dengan prompt di
[`docs/coach-routine.md`](docs/coach-routine.md).

- Klik **Terima program** di dashboard untuk menyimpan program ke Upstash
  Redis. Hari penerimaan dihitung sebagai hari ke-1.
- Progres dihitung otomatis dari `runs.json`. Sesi dianggap selesai kalau
  lari di tanggal itu mencapai ≥ 90% jarak rencana.
- Selama program aktif, kartu target mingguan memakai jarak rencana minggu
  program itu, bukan `WEEKLY_TARGET_KM`.
- Cron sync menyalin program aktif ke `data/active-program.json` untuk
  routine Claude Code. `/api/cron/coach` membacanya langsung dari Redis.
- File yang ditulis AI selalu divalidasi (`lib/coach.ts`). Kalau formatnya
  rusak, dashboard menampilkan pesan error dan tidak memakai isinya.

## Catatan penting soal integrasi COROS

COROS mendokumentasikan jalur OAuth 2.0 self-serve ini ("Build on COROS
MCP") sebagai *"no application or approval required"*, endpoint
`https://mcp.coros.com/mcp`. Kode di `lib/coros-oauth.ts` dan
`lib/coros-mcp-client.ts` mengikuti pola standar (discovery RFC 8414 +
dynamic client registration RFC 7591 + Authorization Code + PKCE) yang
disyaratkan spesifikasi otorisasi MCP.

**Yang belum bisa diverifikasi tanpa kredensial live**: path endpoint
discovery/registrasi persis, serta format respons tool COROS di server MCP
publik ini. Parser di `lib/coros-parsers.ts` ditulis berdasarkan format teks
yang benar-benar teramati untuk `querySportRecords`,
`queryFitnessAssessmentOverview`, `queryTrainingLoadAssessment`,
`queryRestingHeartRate`, `querySleepOverview`, dan `queryStressLevel`. Hanya
`querySportRecords` yang wajib berhasil. Kalau tool lain gagal, sync tetap
jalan dan errornya dicatat di `warnings` hasil sync (lihat Vercel function
logs).

Semua tool dipanggil dalam **satu sesi MCP**, dengan satu kali pengecekan
token. Dengan begitu refresh token tidak dipakai berkali-kali secara paralel,
yang bisa membuat COROS mencabut koneksi. Setelah sync sempat mati, sync
berikutnya otomatis mengambil lari sejak 3 hari sebelum lari terakhir yang
tersimpan (maksimal 120 hari ke belakang).

Tidak ada webhook dari COROS — sinkronisasi selalu berbentuk polling
terjadwal, bukan push instan tiap kali watch selesai sync ke app COROS.

## Struktur data

- `data/runs.json` — daftar aktivitas lari, dedupe by `labelId`.
- `data/fitness.json` — snapshot harian VO2max/running level/prediksi race.
- `data/training-load.json` — snapshot harian short/long-term load.
- `data/body-condition.json` — snapshot harian resting HR/sleep/stress.

## Pengembangan lokal

```bash
npm install
cp .env.example .env.local   # isi manual, atau vercel env pull
npm run dev
```

Catatan: cron & OAuth callback butuh URL publik untuk redirect COROS —
untuk tes end-to-end lokal, gunakan tunnel (ngrok/cloudflared) lalu buka
`/api/coros/authorize` lewat URL tunnel tersebut. Callback otomatis ikut
domain yang dipakai saat menghubungkan, jadi tidak perlu env var.
