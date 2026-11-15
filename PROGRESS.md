# PROGRESS — TixWar API

Dokumen ini mencatat posisi implementasi terhadap `docs/PRD.md`.
Pembaruan terakhir: 15 November 2026, branch `dev`, dokumentasi direvisi sebelum release.

## Ringkasan

- Backend flash sale berjalan sebagai modular monolith: API, worker, dan outbox publisher terpisah.
- Seluruh butir P0, P1, dan P2 dari instruksi kerja sudah dikerjakan: dokumentasi wajib, API key,
  CI, observability, benchmark cache, chaos nyata, `eventStats`, dan feature flag.
- Unit test, Biome, dan TypeScript hijau pada commit terakhir.
- Integration test dan `docker compose build` sudah dijalankan; status detail ada di tabel verifikasi.

## Verifikasi terbaru

| Perintah                     | Hasil                                                         |
| ---------------------------- | ------------------------------------------------------------- |
| `bun test tests/unit`        | 44 pass, 0 fail, 114 expect                                   |
| `bunx biome check .`         | 143 file diperiksa, tidak ada masalah pada verifikasi release |
| `bunx tsc --noEmit`          | 0 error                                                       |
| `bun test tests/integration` | 84 pass, 0 fail, 328 expect (cluster compose hidup)           |
| `docker compose build`       | exit 0 pada verifikasi terakhir; seluruh image build          |

Verifikasi terakhir memakai cluster MongoDB sharded, Redis, Mailpit, dan mock gateway. Integration
test 84/84 lulus; `docker compose build` berhasil membangun image API, worker, publisher, dan gateway.

## Benchmark tersimpan

- `docs/benchmarks/2026-11-14-browse-50vu.md`: p95 107,51 ms, 0 gagal, cache hangat, commit `a8cbb8c`.
- `docs/benchmarks/2026-11-14-war-300vu-100tickets.md`: 300 VU, 100 tiket, 100 order berhasil, 450 `SOLD_OUT`, stok akhir 0, nol oversell, commit `a8cbb8c`.
- `docs/benchmarks/2026-11-14-abuse-rate-limit.md`: 200 request/detik, 97% ditolak 429 dengan `Retry-After`, commit `a8cbb8c`.
- `docs/benchmarks/2026-11-15-browse-cache-cold.md`: browse dingin, p95 149,43 ms, 0 gagal, commit `0aa96c8`.
- `docs/benchmarks/2026-11-15-browse-cache-warm.md`: browse hangat, p95 111,94 ms, 0 gagal, rasio hit katalog > 99%, commit `0aa96c8`.

## Status milestone

| Milestone                      | Status                  | Bukti dan catatan                                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Scaffold (P0)             | Selesai                 | `package.json`, `justfile`, `docker-compose.yml`, `.husky/pre-commit`, `.env.example`, `src/config/env.ts`, `src/modules/health/routes.ts`.                                                                                                                            |
| M1 — Core API (P0)             | Selesai                 | `src/app.ts`, `src/middleware/security.ts`, `src/modules/events/*`, `src/modules/docs/openapi.ts`; test `http-contract.test.ts`, `orders-api.test.ts`.                                                                                                                 |
| M2 — MongoDB data layer (P0)   | Selesai                 | `migrations/001`–`004`, `scripts/seed.ts`, `readPreference: secondaryPreferred` di `events/service.ts`, `sharding.test.ts`.                                                                                                                                            |
| M3 — Auth (P0)                 | Selesai                 | Auth + API key. Route `POST/GET/DELETE /v1/api-keys` (`src/modules/apikeys/*`), `createApiKey()` reuse, hash-only storage, RBAC, key ditampilkan sekali, middleware `X-API-Key` menolak key revoked.                                                                   |
| M4 — Redis (P0)                | Selesai                 | Cache-aside, invalidasi versi, anti-stampede, ETag/304, limiter bertier, fallback in-memory. Benchmark sebelum/sesudah cache tersimpan (`2026-11-15-browse-cache-{cold,warm}.md`).                                                                                     |
| M5 — Native sharding (P0)      | Selesai                 | Shard key `{ userId: 1 }`, indeks compound, metrik shard, `scripts/reshard.ts`, `scripts/verify-sharding.ts`, `sharding.test.ts`.                                                                                                                                      |
| M6 — Order + stock (P0)        | Selesai                 | Lua reserve/release, idempotency Mongo, `POST /orders`, expiry, prewarm, reconcile, `rebuild-stock.ts`; `concurrency.test.ts`.                                                                                                                                         |
| M7 — Outbox + saga (P0)        | Selesai                 | `src/events/publisher.ts`, `src/events/handlers.ts`, BullMQ, DLQ, replay, audit; `outbox.test.ts`.                                                                                                                                                                     |
| M8 — Payment + resilience (P0) | Selesai, dengan catatan | Mock gateway, `/pay`, breaker, 202 QUEUED, retry, Mailpit, webhook HMAC. Pembayaran sukses setelah order expired tetap kompensasi manual (didokumentasikan di `docs/runbook.md`).                                                                                      |
| M9 — Real-time + ticket (P1)   | Selesai                 | SSE stok dan order, QR SVG, object storage, presigned URL, `streaming.test.ts`. MinIO image gagal di Docker Hub; lokal memakai `adobe/s3mock` (ADR 006).                                                                                                               |
| M10 — Observability (P1)       | Selesai                 | Metrics server `:9464` di worker dan outbox-publisher (`src/infra/metrics/server.ts`), OTel auto-instrumentation + span manual BullMQ (`src/infra/tracing.ts`, ADR 007), Sentry opsional (`src/infra/sentry.ts`), dashboard Grafana 15 panel mencakup 7 panel minimum. |
| M11 — Simulasi backend (P1)    | Selesai                 | Chaos redis/mongo injeksi nyata latensi + error (`src/infra/chaos.ts`) dengan auto-recovery dan durasi 30 detik; gateway/worker tetap; `/debug/load`, `/debug/stream`, slow-motion.                                                                                    |
| M12 — Test + CI (P0/P1)        | Selesai                 | `.github/workflows/ci.yml` (Biome, tsc, unit, integration dengan service container, `docker compose build`), `.github/dependabot.yml` (npm + actions), `justfile` `test-sharding` diperbaiki ke `tests/integration/sharding.test.ts`.                                  |
| M13 — Dokumentasi (P0)         | Selesai                 | `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/runbook.md`, `docs/demo-script.md`, koleksi Postman `docs/postman/`, ADR 001–007.                                                                                                                              |
| M14 — Polish (P2)              | Selesai                 | `eventStats` service + route `GET /v1/events/:id/stats` (`src/modules/eventstats/service.ts`), feature flag Redis `sse_enabled`/`payment_retry_enabled` (`src/infra/feature-flags.ts`).                                                                                |

## Gap dan risiko

1. Verifikasi end-to-end trace ke Jaeger belum dijalankan (butuh stack observability penuh naik).
2. Feature flag `payment_retry_enabled` didefinisikan tetapi baru dikonsumsi `sse_enabled`; konsumen
   `payment_retry_enabled` dapat ditambahkan di worker bila diperlukan.

## Catatan audit

- Docker daemon dihidupkan pada sesi ini (sebelumnya mati). Cluster sharded + Redis + Mailpit +
  mock gateway dipakai untuk benchmark, smoke test chaos/P2, integration test (84/84), dan build image.
- `.env` tidak masuk Git; `.env.example` berisi nilai contoh dan kini menyertakan `METRICS_PORT`.
- Secret development di `docker-compose.yml` hanya untuk lingkungan lokal.
- Setiap butir dikerjakan sebagai satu commit terpisah (lihat `git log`): dokumentasi, API key, CI,
  observability, benchmark, chaos, lalu P2.
