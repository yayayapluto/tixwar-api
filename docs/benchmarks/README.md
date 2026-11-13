# Catatan benchmark

Folder ini menyimpan hasil k6 yang benar-benar dijalankan pada mesin pengembangan. Setiap berkas mencatat command persis, environment, jumlah VU, durasi, dan commit saat pengukuran.

Berkas yang tersedia:

- `2026-11-14-browse-cache-warm.md` — browse katalog, cache sudah hangat.
- `2026-11-14-war-300vu-100tickets.md` — simulasi war tiket.

Catatan umum environment:

- Windows 11 (10.0.26200), Docker Desktop 29.8.0, 16 vCPU, RAM 8 GB dialokasikan ke Docker.
- MongoDB 7.0 sharded cluster (3 config server, 3 shard replica set satu anggota, 1 mongos) lewat Docker Compose.
- Redis 7 dengan AOF, Mailpit, `adobe/s3mock` untuk object storage.
- API dijalankan langsung dengan `bun run src/server.ts` pada port 3000 (bukan lewat Nginx), worker dan outbox publisher juga dijalankan sebagai proses Bun terpisah.
- k6 v0.54.0 (windows/amd64).
