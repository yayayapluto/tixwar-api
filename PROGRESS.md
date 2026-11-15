# PROGRESS — TixWar API

Dokumen ini mencatat posisi implementasi terhadap `docs/PRD.md` per 15 November 2026.
Audit dilakukan pada branch `dev`, commit `60ed2d4` (`feat(rate-limit): enforce global and browse tiers`).

## Ringkasan

- Backend flash sale sudah berjalan sebagai modular monolith: API, worker, dan outbox publisher terpisah.
- Unit test, Biome, dan TypeScript hijau pada commit ini.
- Integration test belum dijalankan ulang pada audit ini karena Docker daemon tidak berjalan.
- Benchmark nyata tersimpan untuk browse, war 300 VU vs 100 tiket, dan abuse rate limit.
- Bagian dokumentasi wajib dan CI masih belum lengkap.

## Verifikasi terbaru

| Perintah                     | Hasil                                           |
| ---------------------------- | ----------------------------------------------- |
| `bun test tests/unit`        | 44 pass, 0 fail, 114 expect                     |
| `bunx biome check .`         | 125 file diperiksa, tidak ada masalah           |
| `bunx tsc --noEmit`          | 0 error                                         |
| `bun test tests/integration` | belum dijalankan; Docker daemon mati saat audit |
| `docker compose build`       | belum dijalankan; Docker daemon mati saat audit |

Integration test terdaftar 84 test pada 11 berkas di `tests/integration/`. Status lulus terakhir
berdasarkan ADR 001 (117 test total pada commit lama) dan benchmark commit `a8cbb8c`, bukan hasil
jalankan ulang pada commit `60ed2d4`.

## Benchmark tersimpan

- `docs/benchmarks/2026-11-14-browse-50vu.md`: p95 107,51 ms, 0 gagal, cache hangat, commit `a8cbb8c`.
- `docs/benchmarks/2026-11-14-war-300vu-100tickets.md`: 300 VU, 100 tiket, 100 order berhasil, 450 `SOLD_OUT`, stok akhir 0, nol oversell, commit `a8cbb8c`.
- `docs/benchmarks/2026-11-14-abuse-rate-limit.md`: 200 request/detik, 97% ditolak 429 dengan `Retry-After`, commit `a8cbb8c`.

## Status milestone

| Milestone                      | Status                  | Bukti dan catatan                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 — Scaffold (P0)             | Selesai                 | `package.json`, `justfile`, `docker-compose.yml`, `.husky/pre-commit`, `.env.example`, `src/config/env.ts`, `src/modules/health/routes.ts`.                                                                                                                                                                       |
| M1 — Core API (P0)             | Selesai                 | `src/app.ts`, `src/middleware/security.ts`, `src/modules/events/*`, `src/modules/docs/openapi.ts`; test `http-contract.test.ts`, `orders-api.test.ts`.                                                                                                                                                            |
| M2 — MongoDB data layer (P0)   | Selesai                 | `migrations/001`–`004`, `scripts/seed.ts` (20 event, 60 tier, 5.000 user), `readPreference: secondaryPreferred` di `events/service.ts`, `sharding.test.ts`.                                                                                                                                                       |
| M3 — Auth (P0)                 | Sebagian                | Register/login/refresh/logout, Argon2id, rotasi refresh + reuse detection, RBAC, lockout, dan middleware `X-API-Key` ada. Belum ada route untuk membuat, mencantumkan, atau mencabut API key; `createApiKey()` hanya dipakai test.                                                                                |
| M4 — Redis (P0)                | Sebagian                | Cache-aside, invalidasi versi, anti-stampede, ETag/304, limiter bertier, fallback in-memory, dan test ada. Benchmark sebelum/sesudah cache belum ada; `browse-50vu.md` hanya kondisi cache hangat.                                                                                                                |
| M5 — Native sharding (P0)      | Selesai                 | Shard key `{ userId: 1 }`, indeks compound, metrik shard, `scripts/reshard.ts`, `scripts/verify-sharding.ts`, `sharding.test.ts`.                                                                                                                                                                                 |
| M6 — Order + stock (P0)        | Selesai                 | Lua reserve/release, batas per user, idempotency Mongo, `POST /orders`, expiry, prewarm, reconcile, `rebuild-stock.ts`; `concurrency.test.ts` membuktikan 500 request vs 50 stok.                                                                                                                                 |
| M7 — Outbox + saga (P0)        | Selesai                 | `src/events/publisher.ts`, `src/events/handlers.ts`, BullMQ, DLQ, replay, audit; `outbox.test.ts`.                                                                                                                                                                                                                |
| M8 — Payment + resilience (P0) | Selesai, dengan catatan | Mock gateway, `/pay`, breaker, 202 QUEUED, retry, Mailpit, webhook HMAC, `gateway-failure.test.ts`. Pembayaran sukses setelah order expired masih ditandai untuk kompensasi manual.                                                                                                                               |
| M9 — Real-time + ticket (P1)   | Selesai                 | SSE stok dan order, QR SVG, object storage, presigned URL, `streaming.test.ts`. MinIO image gagal di Docker Hub; lokal memakai `adobe/s3mock` (ADR 006).                                                                                                                                                          |
| M10 — Observability (P1)       | Sebagian                | Prometheus, Alertmanager, Loki, Promtail, Jaeger, mongodb-exporter, dan dashboard overview ada. OTel/Jaeger belum terinstrumentasi (trace pakai Redis + Mongo), Sentry belum ada, dashboard belum mencakup 7 panel minimum, target Prometheus `worker:9464` dan `outbox-publisher:9464` belum ada metrics server. |
| M11 — Simulasi backend (P1)    | Sebagian                | Trace emitter, `/debug/stream`, load single/crowd/abuse, slow-motion, chaos gateway/worker ada. Chaos `redis` dan `mongo` hanya menulis penanda informasi, belum injeksi nyata.                                                                                                                                   |
| M12 — Test + CI (P0/P1)        | Sebagian                | Unit, integration, concurrency, contract, security, dan k6 threshold ada. GitHub Actions, Dependabot, serta Docker image build belum ada/belum terverifikasi. `justfile` juga menunjuk `tests/sharding` yang tidak ada.                                                                                           |
| M13 — Dokumentasi (P0)         | Sebagian                | ADR 001–006 dan benchmark ada. `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/runbook.md`, naskah demo, dan koleksi Bruno/Postman belum ada.                                                                                                                                                             |
| M14 — Polish (P2)              | Belum                   | Koleksi `eventStats` dibuat, tetapi belum ada service/route. Feature flag dan audit hardening belum diimplementasikan.                                                                                                                                                                                            |

## Gap dan risiko yang perlu dikerjakan

1. Dokumentasi wajib: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/runbook.md`, naskah demo, koleksi Bruno/Postman.
2. CI: `.github/workflows/ci.yml`, Dependabot, verifikasi `docker compose build`.
3. Observability: instrumentasi OTel ke Jaeger, Sentry opsional, dashboard cache/rate-limit/queue/breaker/MongoDB/stock, perbaikan target metrik worker.
4. API key: route pembuatan/pencabutan agar fitur bisa dipakai tanpa memanggil fungsi internal.
5. Benchmark cache sebelum/sesudah sesuai PRD Bagian 9.4.
6. Chaos Redis/Mongo yang benar-benar terinjeksi, bukan hanya penanda.
7. `eventStats` dan feature flag bila P0/P1 sudah hijau.
8. `justfile` `test-sharding` mengarah ke direktori `tests/sharding` yang belum ada.

## Catatan audit

- Docker daemon tidak berjalan saat audit, jadi integration test dan Compose build tidak diverifikasi ulang.
- `.env` tidak masuk Git; `.env.example` berisi nilai contoh.
- Secret development di `docker-compose.yml` hanya untuk lingkungan lokal dan bukan credential produksi.
