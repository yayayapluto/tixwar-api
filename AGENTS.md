# AGENTS.md — konvensi repo untuk coding agent

Instruksi untuk agent yang bekerja di repository ini. Baca sebelum mengubah kode. Sumber kebenaran fitur: `docs/PRD.md`; status implementasi: `PROGRESS.md`.

## Ringkasan arsitektur

TixWar adalah backend flash-sale ticketing sebagai **modular monolith**: API, worker, dan outbox publisher adalah proses terpisah (`src/server.ts`, `src/worker.ts`, `src/outbox-publisher.ts`) yang berbagi kode dan dependensi, bukan microservices.

- **Redis** = atomic stock gate + cache + rate limiter + pub/sub + lock.
- **MongoDB** = catatan durable, native sharded melalui `mongos`, shard key `{ userId: 1 }` ranged.
- **BullMQ** = queue per domain (`order`, `payment`, `notification`, `webhook`, `expiry`, `dlq`).
- **Outbox** = regular collection, polling + lease (ADR 003), delivery at-least-once.

Prinsip yang tidak boleh dilanggar (PRD Lampiran A):

1. Aplikasi **hanya** terhubung ke `mongos`, tidak ke shard langsung.
2. Semua query koleksi sharded wajib menyertakan `userId`; query admin lintas user adalah scatter-gather.
3. Unique index pada koleksi sharded diawali shard key.
4. Transaction sesingkat mungkin; **tidak** memanggil Redis/BullMQ/MinIO/SMTP/HTTP di dalam callback transaction.
5. Tidak menjanjikan exactly-once — at-least-once + dedupe `processedEvents`.
6. Redis stock gate fail-closed untuk pembelian (ADR 005); cache baca fail-open.

## Struktur modul

```text
src/
├── server.ts / worker.ts / outbox-publisher.ts   # entrypoint 3 proses
├── mock-gateway/            # gateway pembayaran palsu
├── config/env.ts            # validasi env Zod (satu-satunya pintu env)
├── shared/                  # problem (RFC 7807), logger, ids, cursor, hash, http
├── middleware/              # auth, rateLimit, idempotency, metrics, validate, error, security
├── infra/
│   ├── db/                  # MongoClient, collections, shard-metrics
│   ├── redis/               # client, cache, stock (Lua), pubsub
│   ├── queue/               # BullMQ queues
│   ├── breaker/             # opossum registry + gateway client
│   ├── storage/             # MinIO/S3
│   └── metrics/             # prom-client registry
├── modules/<module>/        # routes.ts + service.ts (+ query.ts bila perlu)
│   └── docs/openapi.ts      # dokumen OpenAPI (zod-to-openapi manual)
├── events/                  # envelope, outbox, publisher, handlers
└── debug/                   # trace emitter, SSE
```

Setiap module mengikuti pola `routes.ts` (Express router, validasi Zod, `buildEnvelope`) + `service.ts` (logika domain, tidak tahu HTTP). Schema Zod + tipe input ditaruh di `src/modules/schemas.ts`.

## Perintah verifikasi

Jalankan setelah setiap perubahan; jangan lanjut jika merah.

```bash
just check          # bunx biome check . && bunx tsc --noEmit
just test           # bun test tests/unit
just test-all       # bun test tests (butuh cluster compose untuk integration)
just check-fix      # biome check --write .
```

Integration test butuh cluster Compose hidup (`just up`); Docker daemon mati → integration test tidak bisa diverifikasi. Jangan mengklaim lulus bila cluster tidak jalan.

## Aturan commit

Conventional Commits, satu commit per butir kerja. Tidak push tanpa instruksi eksplisit.

```
feat(api-key): add create/list/revoke routes with hash-only storage
fix(justfile): point test-sharding at integration/sharding.test.ts
chore(ci): add GitHub Actions + Dependabot
docs(architecture): document order + stock lua flow
```

## Larangan umum

- Jangan menambah dependency tanpa alasan; jelaskan di pesan commit.
- Jangan menulis secret nyata; gunakan `.env.example`. `.env` tidak masuk Git.
- Jangan pakai komentar dekoratif/pemisah seksi (`// ────`, `// ====`). Komentar hanya untuk logika yang tidak jelas.
- Jangan mengubah struktur module yang tidak terkait tugas.
- Jangan membuat test palsu, mock yang menutupi perilaku penting, endpoint kosong, benchmark fiktif, atau klaim fitur yang belum dijalankan.
- Jangan menerima filter/operator Mongo mentah dari input (NoSQL injection). Semua input lewat Zod strict.
- Jangan menyimpan koneksi langsung ke shard di kode API.
- Setiap keputusan arsitektur baru → ADR berikutnya `docs/adr/NNN-...`.

## Konvensi kode

- TypeScript strict, `verbatimModuleSyntax` (pakai `import type` untuk tipe).
- Biome: single quote, semicolons, trailing comma, indent 2, line width 100. Tidak ada `noExplicitAny` (error).
- Response sukses: `buildEnvelope({ data, self, limit, ... })`. Error: `AppError` dari `shared/problem.ts` (RFC 7807).
- ID berprefix (`usr_`, `evt_`, `tier_`, `ord_`, `pay_`, `tix_`), dibuat lewat `shared/ids.ts`.
- Logging lewat `shared/logger.ts` (Pino JSON, redact otomatis untuk secret).
- Metrik lewat `infra/metrics/registry.ts` (prom-client).
