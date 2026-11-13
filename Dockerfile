FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json biome.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
RUN bunx tsc --noEmit

FROM oven/bun:1.3-alpine AS runtime
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts
COPY package.json tsconfig.json ./
USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]
