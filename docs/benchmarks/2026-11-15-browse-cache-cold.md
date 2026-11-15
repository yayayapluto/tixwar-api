# Benchmark browse — 50 VU, 30 detik (cache dingin)

## Command

```bash
k6 run load/browse.js \
  --env BASE_URL=http://127.0.0.1:3000 \
  --env VUS=50 \
  --env DURATION=30s
```

## Environment

| Item | Nilai |
| --- | --- |
| OS | Windows 11 10.0.26200 |
| CPU / RAM | 16 vCPU, 8 GB dialokasikan ke Docker Desktop |
| Docker | 29.8.0, Compose v5.5.1 |
| MongoDB | 7.0 sharded: 3 config server, 3 shard replica set satu anggota, 1 mongos |
| Redis | 7-alpine, AOF `everysec` |
| Runtime API | Bun 1.3.14, `bun run src/server.ts`, port 3000 langsung (tanpa Nginx) |
| k6 | v0.54.0 windows/amd64 |
| Data | 20 event, 60 tier, 5.000 user hasil `bun run scripts/seed.ts` |
| Commit | `0aa96c8` (dev) |

## Kondisi cache

- **Dingin (sebelum cache).** Seluruh kunci cache katalog dihapus sebelum run:
  `redis-cli --scan --pattern 'events:list:*' | xargs redis-cli DEL` dan
  `redis-cli --scan --pattern 'event:detail:*' | xargs redis-cli DEL`.
- Rate limit dinaikkan (`RATE_LIMIT_ANON=100000`, `RATE_LIMIT_GLOBAL=100000`) untuk mengisolasi
  pengukuran cache. Tanpa ini, `anon-browse` 120/mnt/IP dan `global` 300/mnt/IP (mulai aktif pada
  commit `60ed2d4`) akan menolak 429 pada 800+ req/detik sebelum cache sempat hangat.

## Hasil

```
scenarios: browse — constant-vus 50 VU, 30s
http_reqs......................: 24873   825.02/s
iterations.....................: 8291    275.01/s
http_req_duration..............: avg=60.36ms p(90)=113.30ms p(95)=149.43ms max=326.18ms
http_req_failed................: 0.00%   0 out of 24873
checks.........................: 100.00%
```

Threshold `p(95) < 300ms` dan `http_req_failed < 1%` lulus.

## Catatan

- Tiap iterasi mengirim tiga request: `GET /v1/events?limit=20`,
  `GET /v1/events?limit=20&city=jakarta&sort=-startsAt`, dan `GET /health`.
- `/health` tidak melewati cache, menaikkan latensi rata-rata dan jumlah request tanpa menyumbang
  cache hit. Perbandingan sebenarnya untuk katalog terlihat pada pasangan warm di berkas
  `2026-11-15-browse-cache-warm.md`.
