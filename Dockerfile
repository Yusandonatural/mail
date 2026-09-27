# Cloud Run 用。next build の standalone 出力を node で動かす。
# 起動のたびに DB のマイグレーションを行ってからサーバーを立ち上げる。
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm run build:migrate

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/dist/migrate.cjs ./migrate.cjs
COPY --from=build /app/drizzle ./drizzle
EXPOSE 8080
CMD ["sh", "-c", "node migrate.cjs && exec node server.js"]
