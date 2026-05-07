FROM oven/bun:1.3.12 AS base

WORKDIR /app

FROM base AS deps

COPY package.json ./
RUN bun install --frozen-lockfile

FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN bun run build

FROM base AS runner

COPY --from=builder /app/.output ./node_modules/.vite/build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/app.config.ts ./
COPY --from=builder /app/tsconfig.json ./

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["bun", "run", "vinxi", "start"]