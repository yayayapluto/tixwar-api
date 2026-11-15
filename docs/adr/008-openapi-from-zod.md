# ADR 008 — OpenAPI dan tipe klien dihasilkan dari Zod, tanpa dependensi generator

## Konteks

`src/modules/docs/openapi.ts` sebelumnya mendeskripsikan endpoint secara manual: 26 path tetapi hanya 2 `requestBody` dan 1 response schema. Akibatnya kontrak payload hidup di `src/modules/schemas.ts` (Zod) dan tidak pernah terlihat oleh klien. Frontend yang dibangun dari dokumentasi harus menebak body request dan bentuk response.

## Keputusan

- Zod tetap menjadi sumber kebenaran input. Bentuk response dideklarasikan sebagai Zod di `src/modules/docs/models.ts`.
- `src/modules/docs/openapi.ts` memakai `z.toJSONSchema(schema, { target: 'openapi-3.0' })` untuk menghasilkan komponen `components.schemas`, lalu menyusun `paths` dengan `$ref` ke komponen tersebut.
- Field `Date` tidak dapat direpresentasikan Zod di JSON Schema. Konverter menulis ulang field tanggal kosong menjadi `type: string, format: date-time`, dan menghapus `pattern` kalender yang panjang agar dokumen tetap terbaca.
- `scripts/gen-api-types.ts` menulis `docs/openapi.json` dan `docs/api-types.d.ts` dari dokumen yang sama. Emitter tipe ditulis sendiri karena `openapi-typescript` membutuhkan API compiler TypeScript 5, sedangkan repo memakai TypeScript 7 native (`ts.factory` tidak tersedia).
- `/openapi.json` menyajikan dokumen yang identik dengan `docs/openapi.json`; keduanya berasal dari fungsi `buildOpenApiDocument()` yang sama.

## Alternatif

- `zod-to-openapi`: menambah dependensi dan registry terpisah dari skema yang sudah ada.
- `openapi-typescript`: gagal pada TypeScript 7 karena tidak ada `ts.factory`; menurunkan TypeScript ke v5 akan merusak toolchain repo.
- Menulis tipe klien manual: cepat rusak setiap kali Zod berubah.

## Konsekuensi

- Setiap perubahan `schemas.ts` atau `models.ts` wajib diikuti `just api-types`; artefak yang tidak sinkron terdeteksi oleh `tests/unit/openapi.test.ts` (semua `$ref` harus resolve, setiap endpoint mutasi harus punya request body bertipe).
- Emitter tipe adalah kode repo sendiri (~120 baris) sehingga tidak ada risiko rantai pasok tambahan dan tidak ada konflik versi compiler.
- Tipe hasil generate berisi `string` untuk tanggal, sesuai wire format ISO 8601; konversi ke `Date` dilakukan klien.

## Bukti

- `bunx tsc --noEmit` dan `bun test tests/unit` hijau; unit test bertambah dari 44 menjadi 53.
- `/openapi.json` (47 KB) identik dengan `docs/openapi.json` (102 KB pretty-printed); `/docs` mengembalikan 200.
- Respons nyata `GET /v1/events` cocok dengan envelope bertipe; error `POST /v1/orders` cocok dengan `Problem`.
