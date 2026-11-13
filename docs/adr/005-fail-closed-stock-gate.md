# ADR 005 — Fail-closed saat Redis stock gate tidak tersedia

## Konteks

PRD Bagian 9.11 menyatakan fallback Redis stock gate adalah fail closed untuk pembelian baru, kecuali ada strategi inventory failover yang teruji. Cache boleh di-bypass ke MongoDB, tetapi stok tidak boleh ditebak.

## Keputusan

- Bila Lua reserve gagal karena error koneksi/Redis mati, `POST /v1/orders` membalas 503 `DEPENDENCY_UNAVAILABLE` dengan `Retry-After: 5`. Tidak ada order yang dibuat, tidak ada stok yang dikurangi.
- Bila key `stock:{tierId}` belum ada, reserve mengembalikan `STOCK_UNAVAILABLE` dan API membalas 503. Stock tidak diinisialisasi otomatis dari jalur request agar tidak ada dua penulis stok.
- Cache baca (list/detail event) tetap fail-open: kegagalan Redis hanya menghasilkan cache miss dan query ke MongoDB.

## Alternatif

- Fail-open dengan reserve langsung ke MongoDB: butuh transaksi lintas dokumen untuk cek stok, dan tetap rawan oversell karena kuota tier dan order berada di koleksi berbeda.
- Menghitung stok dari `quota - sum(orders aktif)` pada setiap request: benar secara durable tetapi O(n) dan menghancurkan latensi flash sale.

## Konsekuensi

- Redis menjadi dependency keras untuk pembelian; ini konsisten dengan PRD yang menyebut Redis sebagai atomic stock gate.
- Pemulihan: `bun run scripts/rebuild-stock.ts --apply` membangun ulang `stock:{tierId}` dari kuota dan order aktif, dengan maintenance lock `maintenance:rebuild-stock` agar tidak berlomba dengan sale aktif.
- Rekonsiliasi per menit (`src/modules/stock/reconcile.ts`) membandingkan stok Redis dengan stok durable dan menulis `stock_reconcile_drift`, serta menulis ulang stok bila drift terdeteksi.
- Pre-warm lima menit sebelum sale (`src/modules/stock/prewarm.ts`) mengisi stok untuk tier yang belum punya key.

## Bukti

- `tests/integration/stock-gate.test.ts`: "fails closed when stock has not been initialized".
- `src/modules/orders/service.ts` memetakan error stock gate ke `dependencyUnavailable`.
- `tests/integration/concurrency.test.ts`: 500 request paralel → 50 sukses, 450 `SOLD_OUT`, stok Redis berakhir 0.
