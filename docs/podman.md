# Menjalankan TixWar dengan Podman (rootless)

Alternatif dari Docker Compose untuk mesin yang tidak bisa / tidak mau
menjalankan Docker daemon. File compose-nya: `podman-compose.yml`
(cerminan `docker-compose.yml`, lihat header file itu untuk daftar delta).

> **Status: eksperimental.** Konfigurasi ini **belum terverifikasi jalan**
> di VM dev saat ini: Docker sendiri tidak bisa jalan di sana (seccomp
> memblokir `setns(2)`, tidak ada `CAP_NET_ADMIN` — lihat
> `tixwar-infra/DOCKER.md`), dan uji rootless Podman di VM itu masih
> berjalan saat dokumen ini ditulis. Di mesin sendiri / VPS yang mendukung
> Podman rootless, konfigurasi ini diharapkan jalan apa adanya. Jangan
> klaim sudah teruji sebelum ada bukti `podman compose config` + stack
> yang benar-benar naik.

## Prasyarat

- Podman `>= 4.4` (butuh `podman compose` bawaan; standalone Python
  `podman-compose` bisa dipakai tapi mungkin mengabaikan kondisi
  `depends_on` seperti `service_healthy`).
- `just` (opsional, sama seperti alur Docker).
- Rootless: user yang menjalankan harus punya range subuid/subgid,
  misalnya di `/etc/subuid` dan `/etc/subgid` ada baris
  `<user>:100000:65536`. Cek dengan `grep "$USER" /etc/subuid
  /etc/subgid`. Tanpa range ini, Podman rootless gagal membuat user
  namespace.

Instalasi:

```bash
# Debian / Ubuntu
sudo apt-get install -y podman

# Fedora / RHEL
sudo dnf install -y podman

# macOS / Windows (Podman berjalan di VM kecil bawaan)
brew install podman && podman machine init && podman machine start
```

## Menjalankan

```bash
cp .env.example .env
just install            # = bun install --frozen-lockfile

just podman-up          # = podman compose -f podman-compose.yml up -d --build
just podman-up-ha       # = podman compose -f podman-compose.yml --profile ha up -d --build

just migrate
just seed

curl -s http://localhost:8080/health
```

Atau tanpa `just`:

```bash
podman compose -f podman-compose.yml up -d --build
podman compose -f podman-compose.yml --profile ha up -d --build  # profil ha
podman compose -f podman-compose.yml down
podman compose -f podman-compose.yml logs -f api-1 worker
```

Semua URL sama seperti alur Docker: nginx `http://localhost:8080`,
Grafana `http://localhost:3001`, Prometheus `http://localhost:9090`,
Jaeger `http://localhost:16686`, Mailpit `http://localhost:8025`.

## Perbedaan dengan Docker Compose

| Aspek                  | Docker Compose                             | Podman (file ini)                                                                                                                                                                               |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                | Docker daemon (root)                       | Rootless, tanpa daemon                                                                                                                                                                          |
| Jaringan               | bridge + iptables (butuh root)             | Stack rootless default Podman (pasta); tanpa setup privileged                                                                                                                                   |
| `depends_on` condition | Dihormati                                  | Dihormati oleh `podman compose` bawaan; standalone `podman-compose` mungkin mengabaikannya, jadi service bisa start sebelum dependency siap                                                     |
| Promtail               | Jalan, baca log via `/var/run/docker.sock` | **Dihilangkan** — socket Docker tidak ada di bawah Podman; Loki tetap jalan dan menerima push, tapi perlu shipper lain (Promtail dengan static file target / journald) kalau butuh log shipping |
| `minio` `user: root`   | Root di host (dalam container)             | Root di dalam user namespace container saja, dipetakan ke UID host yang tidak privileged                                                                                                        |
| Port publish           | Bebas                                      | Semua port di file ini `>= 1025`, jadi binding rootless jalan                                                                                                                                   |
| Profil `ha`            | `docker compose --profile ha up`           | `podman compose --profile ha up` (secondary tiap shard, sama seperti Docker)                                                                                                                    |

Catatan lain:

- **SELinux (Fedora/RHEL):** bind mount `./docker/...:ro` di file ini
  tidak memakai label `:z`. Bila Podman menolak mount dengan error
  permission, tambahkan `:z` pada mount tersebut (misal
  `./docker/nginx/nginx.conf:/etc/nginx/nginx.conf:ro,z`).
- **Beban resource sama beratnya** dengan Docker: cluster sharded penuh
  (3 configsvr + 3 shard + mongos + 3 API + worker + observability).
  Di mesin kecil, pertimbangkan menjalankan stack minimal secara native
  (lihat runbook infra) daripada cluster penuh.
- **Test integrasi** (`just test-integration`) butuh cluster hidup;
  sama seperti Docker, test gagal cepat `ECONNREFUSED` bila dependency
  tidak jalan (ADR 002). Jalankan test setelah `just podman-up`.
