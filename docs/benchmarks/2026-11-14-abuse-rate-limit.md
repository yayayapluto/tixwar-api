# Benchmark abuse — satu IP, 200 request/detik

## Command

```bash
k6 run load/abuse.js \
  --env BASE_URL=http://127.0.0.1:3000 \
  --env RATE=200 \
  --env DURATION=20s
```

## Environment

| Item | Nilai |
| --- | --- |
| OS | Windows 11 10.0.26200 |
| CPU / RAM | 16 vCPU, 8 GB dialokasikan ke Docker Desktop |
| Redis | 7-alpine, AOF `everysec` (penyimpanan limiter) |
| Runtime | Bun 1.3.14, `bun run src/server.ts`, port 3000 langsung |
| Rate limit | default PRD: browse anonim 120/menit per IP, global 300/menit per IP |
| k6 | v0.54.0 windows/amd64 |
| Commit | `a8cbb8c` (dev), dengan perbaikan deteksi penolakan limiter di commit berikutnya |

## Hasil

```
scenarios: abuse — constant-arrival-rate 200/s, 20s
http_reqs......................: 4000    199.92/s
http_req_duration..............: avg=2.10ms p(95)=4.77ms max=42.94ms
rate_limited_rate..............: 97.00%  3880 out of 4000
checks.........................: 100.00%
```

Threshold `rate_limited_rate > 0.5` lulus. Setiap respons 429 membawa header `Retry-After`.

## Catatan

- Sebelum perbaikan, middleware memeriksa `remainingPoints < 0` padahal `rate-limiter-flexible` mengembalikan 0 saat kuota habis, sehingga tidak pernah menolak. Perbaikan: flag `limited` eksplisit dari jalur reject, dan `Retry-After` diisi `msBeforeNext`.
- Bukti unit/integration: `tests/integration/rate-limit.test.ts` memverifikasi 200,200,200 lalu 429 dengan `Retry-After` dan `application/problem+json`, pemisahan budget per key dan per tier, serta fallback in-memory yang lebih ketat saat Redis gagal.
- Rate limit global dipasang di level aplikasi kecuali `/health`, `/ready`, `/metrics`, dan `/openapi.json` agar probe tidak menghabiskan kuota.
