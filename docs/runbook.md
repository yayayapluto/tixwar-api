# Runbook — TixWar API

Prosedur operasi dan recovery untuk stack development. Perintah `just` mengasumsikan environment sudah termuat dari `.env`.

## Operasi harian

| Aksi           | Perintah                     | Catatan                                    |
| -------------- | ---------------------------- | ------------------------------------------ |
| Naikkan stack  | `just up`                    | `docker compose up -d --build`             |
| Turunkan stack | `just down`                  | `docker compose down`                      |
| Hapus volume   | `just down-volumes`          | `-v`; menghapus data Mongo/Redis/MinIO     |
| Log proses     | `just logs`                  | api x3, worker, outbox-publisher           |
| Cek proses     | `just ps`                    | `docker compose ps`                        |
| Migrasi        | `just migrate`               | idempotent (koleksi, index, schema, shard) |
| Seed           | `just seed`                  | 20 event, 60 tier, 5000 user               |
| Health         | `curl localhost:8080/health` | liveness                                   |
| Readiness      | `curl localhost:8080/ready`  | ping Mongo + Redis + storage + queue       |

Dashboard: Grafana `http://localhost:3001` (admin/admin), Prometheus `http://localhost:9090`, Jaeger `http://localhost:16686`, Mailpit `http://localhost:8025`.

## Reconcile stok (`scripts/rebuild-stock.ts`)

Stok live Redis (`stock:{tierId}`) direkonstruksi dari MongoDB (kuota tier dikurangi jumlah order aktif `PENDING_PAYMENT/PAYMENT_QUEUED/PAID/CONFIRMED`).

```bash
# Dry-run: tampilkan rencana tanpa mengubah apa pun
just rebuild-stock-dry-run      # = bun run scripts/rebuild-stock.ts

# Terapkan: tulis ulang stok Redis + hapus kunci reserved yang basi
bun run scripts/rebuild-stock.ts --apply
```

- Apply memegang maintenance lock `maintenance:rebuild-stock` (`SET NX PX 60000`) agar tidak berlomba dengan sale aktif; bila lock dipegang proses lain, script menolak.
- Rekonsiliasi otomatis berjalan per menit (`src/modules/stock/reconcile.ts`) dan menulis metrik `stock_reconcile_drift`; alert bila drift di atas toleransi.

## Replay DLQ (`scripts/dlq.ts`)

Outbox yang gagal melebihi `OUTBOX_MAX_ATTEMPTS` berstatus `DEAD_LETTER`.

```bash
just dlq-inspect     # daftar dead-letter (max 50) + distribusi status
just dlq-replay      # = bun run scripts/dlq.ts replay (default 100)
bun run scripts/dlq.ts replay 250   # batasi jumlah
```

Delivery at-least-once: replay aman karena consumer dedupe lewat `processedEvents` (unique `{userId, eventId, consumer}`).

## Reshard (`scripts/reshard.ts`)

```bash
just reshard-dry-run             # inspeksi shard key + distribusi, tanpa eksekusi
bun run scripts/reshard.ts --execute   # reshardCollection ke { userId: 1 }
just verify-sharding             # verifikasi shard key + unique index + distribusi
```

`verify-sharding.ts` mengembalikan `ok: false` dan exit code 1 bila ada shard key menyimpang, unique index tidak diawali `userId`, atau distribusi bermasalah. Jangan klaim sukses hanya dari selesainya command; verifikasi jumlah dokumen dan distribusi chunk.

## Penanganan circuit breaker terbuka

State breaker (`payment-gateway`, `smtp`, `webhook`, `minio`) terlihat di `/health` dan Grafana panel "Circuit breaker state".

1. Cek `/ready` dan log worker: `docker compose logs -f worker`.
2. Bila `payment-gateway` Open, order tetap `PAYMENT_QUEUED`; worker retry dengan backoff. Pulihkan mock gateway:

   ```bash
   curl -X POST http://localhost:4000/toggle-fail -H 'content-type: application/json' -d '{"enabled":false}'
   curl -X POST http://localhost:4000/latency -H 'content-type: application/json' -d '{"latencyMs":0}'
   ```
3. Breaker half-open otomatis setelah `BREAKER_RESET_TIMEOUT_MS` (default 20s). Bila tidak pulih, periksa URL `GATEWAY_URL`.

## Pembayaran sukses setelah order expired (kompensasi manual)

Order yang mencapai `expiresAt` ditransisikan ke `EXPIRED` dan stoknya dilepas (release Lua idempoten). Jika gateway kemudian melaporkan pembayaran sukses untuk order tersebut (late payment), tiket **tidak boleh** diterbitkan melebihi stok. Kondisi ini harus dikompensasi manual:

1. Verifikasi order benar-benar `EXPIRED` (bukan `PAYMENT_QUEUED`/`PENDING_PAYMENT`):

   ```bash
   # lewat mongosh terhadap mongos
   mongosh 'mongodb://localhost:27017/tixwar' --eval 'db.orders.findOne({ _id: "ord_..." })'
   ```
2. Pastikan stok sudah dilepas: cek `GET stock:{tierId}` di Redis (`redis-cli GET stock:<tierId>`) atau metrik `stock_remaining`.
3. Bila dana sudah tertagih (di dunia nyata), proses refund melalui gateway — di demo ini cukup mencatat audit `payment.late_refund` dan **tidak** membuat ticket.
4. Dokumentasikan kejadian di audit log (`auditLogs`) dengan `requestId` pembayaran.

Ini adalah skenario kompensasi terdokumentasi (PRD 6.4): jangan pernah menerbitkan tiket melebihi stok.

## Pemulihan Redis / Mongo (chaos)

`POST /debug/chaos` (hanya `DEBUG_ENABLED=true` + admin) menginjeksi kegagalan. Injeksi `redis` dan `mongo` memiliki pemulihan otomatis dan batas durasi (lihat `src/modules/debug/chaos.ts`).

- Redis stock gate fail-closed: pembelian baru → 503 sampai pulih; cache baca tetap fail-open.
- Recovery stok: `just rebuild-stock-dry-run` lalu `--apply`.
- Bila cluster Mongo tidak siap, cek `docker compose ps` dan log `mongo-init` (`docker compose logs mongo-init`).
