# ADR 006 — Object storage: MinIO diganti s3mock untuk environment lokal

## Konteks

PRD Bagian 4.7 dan 9.13 mewajibkan QR tiket disimpan di MinIO dan diakses melalui presigned URL. Pada mesin pengembangan ini, image `minio/minio` tidak dapat diunduh: registry Docker Hub menolak dengan `pull access denied for minio/minio, repository does not exist`, mirror `ghcr.io/minio/minio` menjawab `denied`, dan binary resmi di `dl.min.io` mengembalikan HTTP 410.

## Keputusan

Service `minio` di `docker-compose.yml` memakai `adobe/s3mock:latest` yang melayani S3 API pada port 9000, sehingga `MINIO_ENDPOINT=minio` dan `MINIO_PORT=9000` tidak berubah. Klien tetap `minio` SDK resmi; tidak ada perubahan kode aplikasi. Bucket `tixwar-tickets` dibuat lewat `COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS`, bukan service init terpisah.

Perbedaan yang relevan:

- `adobe/s3mock` tidak punya console web, sehingga verifikasi objek dilakukan lewat presigned URL dan SDK, bukan MinIO console.
- Data disimpan di volume `minio-data` (`COM_ADOBE_TESTING_S3MOCK_STORE_ROOT=/data`), jadi objek bertahan setelah container dibuat ulang.

## Alternatif

- Menulis ulang `StorageContext` ke filesystem lokal: mengubah kontrak implementasi dan menghapus bukti presigned URL.
- Menunda fitur QR sampai image MinIO tersedia: menghilangkan acceptance criteria M9.

## Konsekuensi

- `MINIO_*` env tetap sama; `MINIO_ENDPOINT`/`MINIO_PORT` menunjuk S3-compatible endpoint apa pun.
- Presigned GET URL dihasilkan SDK dan diverifikasi dengan `fetch` sungguhan terhadap objek yang diunggah (lihat bukti).
- MinIO console tidak tersedia pada mesin ini; ini dicatat sebagai blocker parsial untuk item demo "MinIO console".

## Bukti

- `PUT` objek + presigned `GET` mengembalikan HTTP 200 dengan isi objek yang benar melalui `adobe/s3mock` pada port 9000.
- `src/infra/storage/minio.ts` memakai `minio` SDK: `bucketExists`, `makeBucket`, `putObject`, `presignedGetObject`.
