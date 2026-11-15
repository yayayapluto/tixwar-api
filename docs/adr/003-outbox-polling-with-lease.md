# ADR 003 — Outbox publisher memakai polling dengan lease, bukan Change Streams

## Konteks

PRD Bagian 9.10 mengizinkan dua strategi publisher outbox: Change Streams dengan resume token persisten, atau polling terkontrol dengan atomic claim. Keduanya wajib tahan restart, duplicate delivery, dan recovery. Pemilihan harus dicatat di ADR.

## Keputusan

Polling dengan atomic claim `PENDING → PUBLISHING` dan `leaseUntil`.

Alur klaim di `src/events/publisher.ts`:

1. Ambil kandidat `PENDING` dengan `leaseUntil` null atau kedaluwarsa, plus `PUBLISHING` yang lease-nya habis.
2. Untuk setiap kandidat, `findOneAndUpdate` bersyarat pada `_id` + kondisi status/lease. Hanya satu publisher yang berhasil per dokumen.
3. Enqueue BullMQ dengan `jobId` deterministik `job-<outboxId>`.
4. Set `PUBLISHED` + `publishedAt` hanya setelah enqueue sukses.

Saat enqueue gagal: `attempts += 1`, status kembali `PENDING`, dan `leaseUntil` diisi backoff eksponensial + jitter (`min(30s, 500ms × 2^attempts) + 0..250ms`). Setelah `OUTBOX_MAX_ATTEMPTS` (default 5) status menjadi `DEAD_LETTER`, yang bisa di-replay lewat `scripts/dlq.ts replay`.

## Alternatif

- Change Streams: butuh resume token persisten dan penanganan `ChangeStreamHistoryLost`. Untuk demo lokal dengan satu publisher, lease polling memberi jaminan yang sama tanpa state tambahan.
- `FOR UPDATE SKIP LOCKED` gaya SQL: tidak ada di MongoDB; lease adalah padanan yang benar.

## Konsekuensi

- Crash publisher di tengah jalan tidak menghilangkan event: lease kedaluwarsa dan event diklaim ulang (dibuktikan test "survives a publisher restart without losing events").
- Duplicate delivery mungkin terjadi pada window crash setelah enqueue sebelum update status. Consumer menangani ini lewat `processedEvents` dengan unique index `{ userId, eventId, consumer }`.
- Latensi publish dibatasi `OUTBOX_POLL_INTERVAL_MS` (default 250 ms). Cukup untuk demo dan load test.

## Bukti

- `tests/integration/outbox.test.ts`: klaim lease, duplicate job id, restart recovery, retry+backoff, DLQ, replay, dedupe consumer.
- `bun run scripts/dlq.ts inspect` dan `replay` membaca status nyata dari `outboxEvents`.
