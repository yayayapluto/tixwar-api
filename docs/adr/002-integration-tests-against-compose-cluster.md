# ADR 002 — Integration test memakai cluster Compose, bukan Testcontainers

## Konteks

PRD menyarankan Testcontainers modul MongoDB replica set untuk integration test, sekaligus menyatakan bahwa test sharding native harus memakai profile Compose karena replica set tunggal tidak membuktikan routing sharded.

## Keputusan

Integration test terhubung langsung ke cluster yang sama dengan stack development: `mongodb://localhost:27017` (mongos) dan Redis `localhost:6379/1`. Tidak ada Testcontainers.

Test memakai database terpisah `tixwar_test`, Redis DB 1, dan prefix queue `tixwar-test`. Helper `tests/support/harness.ts` menjalankan migrasi, membersihkan koleksi, dan menyalakan HTTP server pada port acak.

## Alternatif

- Testcontainers `mongodb` dengan replica set: tidak dapat membuktikan sharding native, dan menambah waktu start ~30 detik per suite.
- Testcontainers untuk Redis: tidak menambah bukti dibanding Redis lokal.

## Konsekuensi

- Prasyarat test: `docker compose up -d` untuk `mongos`, `mongo-*`, dan `redis`. Bila cluster tidak jalan, test gagal cepat dengan `ECONNREFUSED` (bukan false green).
- Test benar-benar menguji sharding, transaksi, index unik compound, dan read preference pada topologi nyata.
- Test tidak self-contained: butuh cluster eksternal. Ini didokumentasikan di README dan `AGENTS.md`.

## Bukti

- `tests/integration/sharding.test.ts` membuktikan `SHARD_MERGE` untuk query tanpa shard key dan `SINGLE_SHARD` untuk query ber-`userId`, setelah `split` + `moveChunk` nyata.
- `tests/integration/concurrency.test.ts` membuktikan 500 request paralel terhadap 50 stok menghasilkan tepat 50 sukses.
