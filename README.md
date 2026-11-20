# TixWar — Flash Sale Ticketing API

Backend penjualan tiket event dengan skenario _flash sale_: ribuan pengguna berebut stok terbatas dalam hitungan detik. Fokusnya bukan CRUD, melainkan system design tahan beban: **nol oversell**, **tanpa order ganda**, tetap beroperasi saat dependency eksternal bermasalah, dan seluruh perilakunya dapat diamati lewat trace, metrik, dan log.

Proyek ini **murni backend** — tidak ada frontend. UI yang dipakai hanya tool bawaan pihak ketiga (Swagger UI, Grafana, Jaeger, Mailpit, MinIO console).

Stack: **Bun** + **TypeScript strict**, **Express 5**, **MongoDB 7 native sharded** (via `mongos`), **Redis 7** (atomic stock gate + cache), **BullMQ** (queue), modular monolith dengan tiga proses terpisah.

---

## Arsitektur singkat

Proses yang berjalan (modular monolith, bukan microservices):

| Proses           | Berkas                       | Peran                                                                |
| ---------------- | ---------------------------- | -------------------------------------------------------------------- |
| API              | `src/server.ts`              | HTTP Express, stateless. Semua state di Redis/MongoDB.               |
| Worker           | `src/worker.ts`              | Konsumen BullMQ untuk order, payment, notification, webhook, expiry. |
| Outbox publisher | `src/outbox-publisher.ts`    | Polling outbox Mongo → enqueue BullMQ (lease, at-least-once).        |
| Mock gateway     | `src/mock-gateway/server.ts` | Gateway pembayaran palsu dengan `/toggle-fail` dan `/latency`.       |

Alur inti satu pembelian:

1. `POST /v1/orders` → **Lua reserve** di Redis (`stock:{tierId}`) adalah gerbang stok atomik.
2. Dalam satu MongoDB transaction (shard `userId` yang sama): insert `orders` + `outboxEvents` `order.created`.
3. Outbox publisher mengklaim event (polling + lease) dan enqueue BullMQ dengan `jobId` deterministik.
4. Worker memproses `payment.requested` → mock gateway lewat circuit breaker → `order.paid` → `tickets` + QR MinIO → `order.confirmed`.

Redis adalah _atomic stock gate_; MongoDB adalah catatan durable. Detil lengkap: `docs/architecture.md`. Keputusan yang menyimpang dari PRD: `docs/adr/`.

---

## Prasyarat

- [Bun](https://bun.sh) `>= 1.3` (runtime, test runner, package manager).
- [Docker](https://www.docker.com/) + Docker Compose v2 (cluster MongoDB sharded, Redis, dan stack observability) — atau [Podman](https://podman.io/) rootless sebagai alternatif, lihat `docs/podman.md`.
- [just](https://github.com/casey/just) (command runner; opsional — semua target bisa dijalankan manual).
- [k6](https://k6.io/) (opsional, hanya untuk load test).

---

## Quickstart

```bash
# 1. Salin konfigurasi (nilai contoh sudah cukup untuk development lokal)
cp .env.example .env

# 2. Install dependency
just install            # = bun install --frozen-lockfile

# 3. Naikkan seluruh stack (mongo sharded + redis + api x3 + worker + publisher + observability)
just up                 # = docker compose up -d --build

# 4. Jalankan migrasi (idempotent) dan seed data demo (20 event, 3 tier/event, 5000 user)
just migrate            # = bun run scripts/migrate.ts
just seed               # = bun run scripts/seed.ts

# 5. Cek health dan buka dokumentasi
curl -s http://localhost:8080/health        # via nginx
curl -s http://localhost:8080/openapi.json   # spesifikasi OpenAPI
# Swagger UI: http://localhost:8080/docs
```

Stack observability (setelah `just up`):

| Tool          | URL                                                                |
| ------------- | ------------------------------------------------------------------ |
| Swagger UI    | `http://localhost:8080/docs`                                       |
| Grafana       | `http://localhost:3001` (admin/admin)                              |
| Prometheus    | `http://localhost:9090`                                            |
| Jaeger        | `http://localhost:16686`                                           |
| Mailpit       | `http://localhost:8025`                                            |
| MinIO console | `http://localhost:9001` (bila image MinIO tersedia; lihat ADR 006) |

Akses API langsung lewat nginx `http://localhost:8080` (load balance ke `api-1..3`).

Profil `ha` menambahkan secondary untuk tiap shard replica set:

```bash
just up-ha              # = docker compose --profile ha up -d --build
```

> Topologi lokal memakai **satu anggota per shard**. Ini membuktikan native sharding dan transaksi replica-set, tetapi **bukan** high availability node-level. Secondary read preference hanya terbukti pada profil `ha`.

### Podman (alternatif Docker)

Stack yang sama bisa dijalankan rootless dengan Podman, tanpa Docker daemon:

```bash
just podman-up          # = podman compose -f podman-compose.yml up -d --build
just podman-up-ha       # = podman compose -f podman-compose.yml --profile ha up -d --build
```

Satu-satunya service yang dihilangkan dari `podman-compose.yml` adalah
`promtail` (butuh socket Docker). Statusnya **eksperimental dan belum
terverifikasi di VM dev** — detail instalasi, perbedaan dengan Docker
Compose, dan keterbatasannya ada di `docs/podman.md`.

---

## Daftar environment

Seluruh env divalidasi Zod saat startup (`src/config/env.ts`); placeholder secret ditolak di `NODE_ENV=production`. Sumber kanonik: `.env.example`. Variabel penting:

| Variabel                                   | Default                             | Keterangan                                            |
| ------------------------------------------ | ----------------------------------- | ----------------------------------------------------- |
| `NODE_ENV`                                 | `development`                       | `development` / `test` / `production`                 |
| `PORT`                                     | `3000`                              | Port HTTP API                                         |
| `MONGODB_URI`                              | `mongodb://mongos:27017/tixwar?...` | Wajib menunjuk `mongos`, bukan shard langsung         |
| `REDIS_URL`                                | `redis://redis:6379/0`              | Redis (stock gate + cache + limiter)                  |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | —                                   | Min 16 karakter; wajib diisi                          |
| `GATEWAY_URL`                              | `http://mock-gateway:4000`          | Mock payment gateway                                  |
| `SMTP_URL`                                 | `smtp://mailpit:1025`               | Email (Mailpit)                                       |
| `MINIO_*`                                  | lihat `.env.example`                | Object storage QR ticket                              |
| `DEBUG_ENABLED`                            | `false`                             | Aktifkan route `/debug/*` (perlu `DEBUG_ADMIN_TOKEN`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`              | `http://jaeger:4318`                | Endpoint OTLP Jaeger                                  |
| `SENTRY_DSN`                               | (kosong)                            | Opsional; Sentry hanya aktif bila diisi               |

Seluruh nilai tier rate limit, TTL cache, timeout breaker, concurrency worker, dan TTL order juga configurable — lihat `.env.example`.

---

## Menjalankan test

```bash
# Unit test (baseline hijau: 44 pass)
just test               # = bun test tests/unit

# Integration test (butuh cluster compose: mongos, redis, Mailpit, mock gateway)
just up                 # prasyarat cluster
just test-integration   # = bun test tests/integration

# Semua test
just test-all           # = bun test tests

# Sharding native (test routing + unique index pada cluster sharded)
just test-sharding      # = bun test tests/integration/sharding.test.ts
```

Integration test memakai database terpisah `tixwar_test`, Redis DB 1, dan prefix queue `tixwar-test` (lihat `tests/setup.ts`). Test membutuhkan `mongos`, Redis, Mailpit, dan mock gateway dari Compose; object storage dapat memakai S3-compatible endpoint sesuai ADR 006. Test gagal cepat `ECONNREFUSED` bila dependency tidak jalan (ADR 002).

Verifikasi statis:

```bash
just check              # = biome check . + tsc --noEmit
just check-fix          # = biome check --write .
```

---

## Benchmark

Load test k6 di `load/` (smoke, browse, war, abuse, soak). Token khusus load test dibuat dengan `scripts/gen-tokens.ts` — jangan pakai akun pribadi.

```bash
just gen-tokens                 # cetak JSON token (atau --existing untuk user seed)
just browse                     # k6 run load/browse.js (threshold p95 < 300ms)
just war                        # k6 run load/war.js (perlu TIER_ID + TOKENS)
just abuse                      # k6 run load/abuse.js
```

Hasil nyata disimpan di `docs/benchmarks/` (commit, kondisi cache, VU, durasi, hasil). Contoh perintah manual:

```bash
k6 run --env BASE_URL=http://localhost:8080 --env VUS=50 --env DURATION=30s load/browse.js
```

---

## Skrip operasional

| Perintah                               | Fungsi                                            |
| -------------------------------------- | ------------------------------------------------- |
| `just migrate`                         | Migrasi koleksi/index/schema (idempotent)         |
| `just seed` / `just seed-force`        | Seed 20 event + 60 tier + 5000 user               |
| `just verify-sharding`                 | Periksa shard key, unique index, distribusi       |
| `just reshard-dry-run`                 | Dry-run reshard (eksekusi hanya `--execute`)      |
| `just rebuild-stock-dry-run`           | Rebuild stok Redis dari MongoDB (apply `--apply`) |
| `just dlq-inspect` / `just dlq-replay` | Inspeksi / replay DLQ outbox                      |

Detil operasional dan recovery: `docs/runbook.md`.

---

## Kontrak API untuk klien (frontend)

OpenAPI dihasilkan dari Zod, jadi bukan lagi inventaris endpoint saja:

```bash
just api-types      # = bun run scripts/gen-api-types.ts
```

Menulis dua artefak:

| Berkas                | Isi                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `docs/openapi.json`   | OpenAPI 3.0.3: 26 path, 39 schema, request body, response envelope, `Problem`, header rate limit/ETag, SSE |
| `docs/api-types.d.ts` | Tipe TypeScript siap pakai: `components['schemas']['Order']`, `paths['/v1/orders']['post']`                |

Kedua berkas dihasilkan — jangan diedit manual. Jalankan ulang setelah mengubah `src/modules/schemas.ts` atau `src/modules/docs/models.ts`.

Endpoint kontrak saat runtime:

- `GET /openapi.json` — dokumen yang sama persis dengan `docs/openapi.json`.
- `GET /docs` — Swagger UI.

Catatan integrasi frontend:

- Auth: `Authorization: Bearer <accessToken>`; refresh via `POST /v1/auth/refresh` (rotasi token, reuse terdeteksi).
- Mutasi order dan pay wajib `Idempotency-Key`.
- Sukses selalu `{ data, meta, links }`; error selalu `application/problem+json`.
- Uang integer rupiah, waktu ISO 8601 UTC.
- SSE: `GET /v1/events/:id/stream` dan `GET /v1/orders/:id/stream`, frame `event: ready|message|heartbeat`.
- Tambahkan origin frontend ke `CORS_ORIGINS` sebelum memanggil dari browser.

---

## Dokumentasi

- `docs/architecture.md` — komponen, order + stok Lua, outbox + saga, sharding, cache, rate limit, observability, read model, feature flags.
- `docs/runbook.md` — operasi harian, recovery, chaos Redis/Mongo, DLQ, reshard, dan late payment.
- `docs/demo-script.md` — naskah demo presentasi.
- `docs/adr/` — Architecture Decision Records, termasuk keputusan OTel/BullMQ.
- `docs/benchmarks/` — hasil load test nyata sebelum/sesudah cache.
- `docs/postman/` — koleksi request Postman (auth, events, orders, pay, SSE, API key).
- `docs/openapi.json` / `docs/api-types.d.ts` — kontrak OpenAPI dan tipe klien hasil generate.
- `AGENTS.md` — konvensi repo untuk coding agent.
