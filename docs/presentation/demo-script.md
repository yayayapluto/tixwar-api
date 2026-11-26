# Naskah demo — TixWar

Demo end-to-end untuk presentasi. Asumsi: stack sudah naik (`just up`), migrasi dan seed selesai (`just migrate && just seed`), `DEBUG_ENABLED=true` (default di compose).

## 1. Arsitektur dan satu request pembelian

Tampilkan `docs/architecture.md` (C4 + sequence). Jalan satu alur:

```bash
# register -> login -> browse -> order -> pay -> ticket
curl -s http://localhost:8080/ready | jq .
```

## 2. Slow-motion dan trace satu request

```bash
# stream trace di terminal 1
curl -N -H "Authorization: Bearer $TOKEN" http://localhost:8080/debug/stream

# terminal 2: request dengan slow-motion 400ms
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Debug-Slow: 400" \
  'http://localhost:8080/v1/events?limit=20' | jq .
```

Tunjukkan node yang dilewati (`api-N`, `cache`, `mongos`, `shard-N`, dst) di stream dan trace Jaeger `http://localhost:16686`.

## 3. Browse dan cache hit ratio

```bash
# hangatkan cache lalu kirim 200 request browse
for i in $(seq 1 200); do curl -s 'http://localhost:8080/v1/events?limit=20' >/dev/null; done
```

Buka Grafana panel "Cache hit ratio" — tunjukkan rasio hit naik setelah cache hangat. Bandingkan dengan benchmark `docs/benchmarks/` (sebelum/sesudah cache).

## 4. War: 1000 user vs 100 tiket

```bash
just gen-tokens > /tmp/tokens.json   # buat token load test
# ambil TIER_ID dari seed; jalankan war
TIER_ID=tier_xxx k6 run --env TIER_ID=$TIER_ID --env VUS=1000 \
  --env TOKENS_FILE=/tmp/tokens.txt load/war.js
```

Bukti: stok jadi 0, sisanya `SOLD_OUT`, nol oversell. Tampilkan `orders_total{status}` dan `stock_remaining` di Grafana.

## 5. Rate limit

```bash
# spam 200 request/detik dari satu IP
just abuse        # k6 run load/abuse.js
```

Tunjukkan 429 + `Retry-After` dan panel "Rate limit rejections".

## 6. Matikan satu instance API

```bash
docker compose stop api-2
# nginx mengalihkan traffic ke api-1/api-3
curl -s http://localhost:8080/health | jq .
docker compose start api-2
```

## 7. Gateway down -> breaker open -> QUEUED -> pulih -> CONFIRMED

```bash
curl -X POST http://localhost:4000/toggle-fail -H 'content-type: application/json' -d '{"enabled":true}'
# order + pay -> 202 QUEUED; panel breaker jadi Open
curl -X POST http://localhost:4000/toggle-fail -H 'content-type: application/json' -d '{"enabled":false}'
# worker retry -> order CONFIRMED, ticket terbit
```

## 8. Worker gagal -> retry -> DLQ -> replay

Injeksi failure rate lalu amati retry → DLQ, lalu `just dlq-replay`. Tunjukkan tidak ada side effect ganda (dedupe `processedEvents`).

## 9. Distribusi shard

```bash
just verify-sharding
```

Tampilkan distribusi dokumen per shard (`mongodb_shard_documents`) dan jelaskan trade-off ranged `userId`, unique index, scatter-gather, resharding.

## 10. Penutup

Rujuk benchmark nyata di `docs/benchmarks/` (commit, VU, durasi, hasil) — bukan data fiktif.

---

## Perintah auth cepat (untuk $TOKEN)

```bash
TOKEN=$(curl -s http://localhost:8080/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@tixwar.local","password":"TixWar-Admin-2024"}' | jq -r .data.accessToken)
```

Akun seed: `admin@tixwar.local` / `TixWar-Admin-2024` (bila tidak diubah lewat `SEED_ADMIN_*`).
