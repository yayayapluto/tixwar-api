# ADR 004 — Shard key `{ userId: 1 }` ranged dan konsekuensi unique index

## Konteks

PRD Bagian 9.5 dan Lampiran A menetapkan shard key baseline `{ userId: 1 }` ranged untuk `orders`, `payments`, `tickets`, `outboxEvents`, `processedEvents`, dan `auditLogs`. MongoDB hanya menjamin unique index pada sharded collection bila key index diawali shard key, dan tidak ada jaminan unik global lewat `_id` saja.

## Keputusan

- Shard key `{ userId: 1 }` ranged untuk enam koleksi transaksi.
- `userId` dibangkitkan sebagai `usr_` + UUIDv4 (acak, non-sekuensial), sehingga insert tersebar ke seluruh rentang alih-alih menumpuk di ujung atas.
- Setiap unique index pada koleksi sharded diawali `userId`:
  - `orders`: `{ userId: 1, _id: 1 }`
  - `payments`: `{ userId: 1, _id: 1 }`
  - `tickets`: `{ userId: 1, _id: 1 }` dan `{ userId: 1, code: 1 }`
  - `outboxEvents`: `{ userId: 1, _id: 1 }`
  - `processedEvents`: `{ userId: 1, eventId: 1, consumer: 1 }`
- `users`, `events`, `ticketTiers`, `idempotencyKeys` tetap unsharded agar unique global (`email`, `{ scope, ownerId, key }`) sederhana dan tidak butuh index yang diawali shard key.

## Alternatif

- Hashed shard key `{ userId: 'hashed' }`: sebaran lebih rata, tetapi unique index hanya boleh berupa `{ userId: hashed }` atau `{ _id: 1 }`. Itu mematikan unique `{ userId, code }` dan dedupe `processedEvents`. Ditolak.
- Shard key `{ _id: 1 }`: query per user menjadi scatter-gather penuh. Ditolak.
- Sharding `idempotencyKeys`: unique global lintas user tidak dapat dijamin tanpa index berawalan shard key. Ditolak untuk baseline.

## Konsekuensi

- Semua query transaksi wajib menyertakan `userId` dari token. Repository menerima `userId` sebagai parameter eksplisit; cursor `/orders` menyimpan `scope = userId` dan menolak cursor milik user lain dengan 400.
- Query admin lintas user (misalnya laporan) adalah scatter-gather. Untuk demo ini hanya dipakai pada koleksi kecil atau agregasi terbatas.
- Hot shard mungkin terjadi bila satu event sangat populer; `userId` acak menyebar reservasi, tetapi tier populer tetap memusatkan trafik tulis ke `stock:{tierId}` di Redis, bukan ke satu shard Mongo.
- `scripts/reshard.ts` menyediakan dry-run default yang memeriksa shard key aktual dan menandai koleksi yang menyimpang, dengan `--execute` untuk menjalankan `reshardCollection`.
- `scripts/verify-sharding.ts` memeriksa shard key, prefix unique index, dan distribusi dokumen per shard; exit code 1 bila ada masalah.

## Bukti

- `tests/integration/sharding.test.ts` memverifikasi shard key aktual dari `config.collections`, prefix unique index, `SINGLE_SHARD` untuk query `userId`, dan `SHARD_MERGE` untuk query tanpa shard key setelah `split` + `moveChunk`.
- `bun run scripts/verify-sharding.ts` mengembalikan `ok: true` pada cluster lokal.
