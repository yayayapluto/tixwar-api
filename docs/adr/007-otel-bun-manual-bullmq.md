# ADR 007 — OpenTelemetry dengan auto-instrumentation di Bun dan propagasi manual untuk BullMQ

## Konteks

PRD Bagian 10 mewajibkan trace OpenTelemetry dari HTTP → queue → worker → mock gateway/notification ke Jaeger, mencakup HTTP, Redis, MongoDB, dan job BullMQ. Runtime proyek adalah Bun (ADR 001). `@opentelemetry/instrumentation-bullmq` yang ada di registry tidak mendukung BullMQ 6 (peer dependency terbatas `^2 || ^3 || ^4 || ^5`), sehingga job BullMQ tidak dapat diinstrumentasi lewat paket otomatis.

## Keputusan

- Pakai `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node` (mencakup `http`, `express`, `ioredis`, `mongodb`) dan eksport `OTLPTraceExporter` (OTLP/HTTP) ke `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Trace context diinjeksikan manual ke payload outbox sebagai `traceparent` di `buildOutboxDoc` (`src/events/outbox.ts`) memakai `propagation.inject`.
- Publisher mengekstrak `traceparent` dari payload outbox dan membuat span `outbox.enqueue <type>` (`src/events/publisher.ts`).
- Worker mengekstrak `traceparent` dari `job.data.data.traceparent` dan membuat span `bullmq.<queue>.<type>` (`src/worker.ts`). Ini menggantikan kebutuhan `opentelemetry-instrumentation-bullmq` yang tidak kompatibel dengan BullMQ 6.
- Tracing bersifat opt-in: hanya aktif bila `OTEL_EXPORTER_OTLP_ENDPOINT` di-set. Kegagalan init ditangkap dan dicatat, tidak menggagalkan startup.
- Sentry (`@sentry/bun`) hanya diinisialisasi bila `SENTRY_DSN` di-set; `captureError` no-op tanpa DSN.

## Alternatif

- `opentelemetry-instrumentation-bullmq`: ditolak karena tidak mendukung BullMQ 6.
- Menulis manual span untuk HTTP/Redis/Mongo: butuh hook per operasi Redis yang invasif; auto-instrumentation lebih sedikit kode dan mengikuti API OTel.
- Mengganti runtime ke Node agar auto-instrumentation lebih matang: bertentangan dengan ADR 001.

## Konsekuensi

- Auto-instrumentation OTel di Bun bergantung pada dukungan hook modul Bun (`require-in-the-middle`/`import-in-the-middle`). Bila gagal, proses tetap jalan tanpa trace (log warning), dan span manual BullMQ/outbox tetap direkam saat tracing aktif.
- Span manual BullMQ/outbox memakai `trace.getTracer('tixwar')`; tanpa provider yang aktif, tracer menjadi no-op sehingga tidak ada biaya saat tracing dimatikan.
- Propagasi end-to-end HTTP → outbox → queue → worker mengalir lewat field `traceparent` pada payload outbox, bukan lewat header queue milik BullMQ.

## Bukti

- `bunx tsc --noEmit` dan `bun test tests/unit` hijau setelah penambahan.
- Verifikasi end-to-end ke Jaeger **belum dijalankan** karena Docker daemon mati saat pengerjaan; dicatat sebagai blocker pada laporan.
