# Benchmark browse — 50 VU, 30 detik (cache hangat)

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

- **Hangat (sesudah cache).** Run ini dilakukan langsung setelah run cache dingin
  (`2026-11-15-browse-cache-cold.md`) tanpa menghapus kunci. Cache list event terisi penuh.
- Metrik sesudah run: `cache_hits_total{cache="events-list"} 34762`,
  `cache_misses_total{cache="events-list"} 200` (rasio hit > 99% untuk katalog).
- Rate limit dinaikkan (`RATE_LIMIT_ANON=100000`, `RATE_LIMIT_GLOBAL=100000`) dengan alasan yang
  sama seperti run dingin.

## Hasil

```
scenarios: browse — constant-vus 50 VU, 30s
http_reqs......................: 27570   916.21/s
iterations.....................: 9190    305.40/s
http_req_duration..............: avg=46.66ms p(90)=94.02ms p(95)=111.94ms max=208.31ms
http_req_failed................: 0.00%   0 out of 27570
checks.........................: 100.00%
```

Threshold `p(95) < 300ms` dan `http_req_failed < 1%` lulus.

## Perbandingan sebelum/sesudah cache

| Metrik | Dingin (sebelum) | Hangat (sesudah) | Delta |
| --- | --- | --- | --- |
| p95 latency | 149.43 ms | 111.94 ms | −25.1% |
| p90 latency | 113.30 ms | 94.02 ms | −17.0% |
| avg latency | 60.36 ms | 46.66 ms | −22.7% |
| throughput | 825.02 req/s | 916.21 req/s | +11.1% |

## Catatan

- `/health` tidak melewati cache sehingga menurunkan rasio hit agregat dan menyeret latensi
  rata-rata; rasio katalog murni (hit > 99%) diambil dari metrik `cache_hits_total`/`cache_misses_total`.
- Tiap iterasi mengirim tiga request: `GET /v1/events?limit=20`,
  `GET /v1/events?limit=20&city=jakarta&sort=-startsAt`, dan `GET /health`.
