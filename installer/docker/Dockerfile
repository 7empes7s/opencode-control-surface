FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json .
COPY --from=builder /app/bun.lockb .
RUN bun install --frozen-lockfile --production
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["bun", "server/main.ts"]