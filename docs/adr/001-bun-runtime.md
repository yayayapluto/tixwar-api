# ADR 001 — Runtime Bun untuk API, worker, dan publisher

## Konteks

PRD Bagian 4 menetapkan Bun dan TypeScript strict sebagai runtime, `bun test` sebagai test runner, dan memberi ruang fallback ke Node hanya bila BullMQ atau Testcontainers gagal berjalan di Bun (PRD Bagian 19).

## Keputusan

Seluruh proses memakai Bun 1.3: `src/server.ts`, `src/worker.ts`, `src/outbox-publisher.ts`, dan `src/mock-gateway/server.ts`. Tidak ada fallback Node.

## Alternatif

- Menjalankan worker di Node karena BullMQ secara historis berorientasi Node.
- Memakai Vitest sebagai test runner.

## Konsekuensi

- Satu runtime, satu toolchain, satu cara menjalankan test. `bun test` mengeksekusi unit dan integration test dengan preload `tests/setup.ts`.
- BullMQ 6.7 berjalan di Bun tanpa shim. Smoke test M0 membuktikan worker menerima job dan menyelesaikan handler.
- Testcontainers tidak dipakai. Integration test memakai cluster Compose yang sama dengan runtime aplikasi (lihat ADR 002).

## Bukti

- `bun test tests` menjalankan 117 test (unit + integration) tanpa kegagalan.
- `src/worker.ts` memproses `order.created`, `payment.requested`, `order.paid`, dan `order.confirmed` pada test `tests/integration/gateway-failure.test.ts`.
