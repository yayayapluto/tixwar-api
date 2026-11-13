set dotenv-load := false

default:
    @just --list

up:
    docker compose up -d --build

up-ha:
    docker compose --profile ha up -d --build

down:
    docker compose down

down-volumes:
    docker compose down -v

logs:
    docker compose logs -f api-1 api-2 api-3 worker outbox-publisher

ps:
    docker compose ps

build:
    docker compose build

install:
    bun install --frozen-lockfile

check:
    bunx biome check .
    bunx tsc --noEmit

check-fix:
    bunx biome check --write .

test:
    bun test tests/unit

test-integration:
    bun test tests/integration

test-all:
    bun test tests

test-sharding:
    bun test tests/sharding

migrate:
    bun run scripts/migrate.ts

seed:
    bun run scripts/seed.ts

seed-force:
    bun run scripts/seed.ts --force

verify-sharding:
    bun run scripts/verify-sharding.ts

reshard-dry-run:
    bun run scripts/reshard.ts

rebuild-stock-dry-run:
    bun run scripts/rebuild-stock.ts

dlq-inspect:
    bun run scripts/dlq.ts inspect

dlq-replay:
    bun run scripts/dlq.ts replay

gen-tokens:
    bun run scripts/gen-tokens.ts

load scenario:
    k6 run load/{{scenario}}.js

war:
    k6 run load/war.js

browse:
    k6 run load/browse.js

smoke:
    k6 run load/smoke.js

abuse:
    k6 run load/abuse.js

soak:
    k6 run load/soak.js

dev:
    bun --watch src/server.ts

ci:
    just check && just test && docker compose build
