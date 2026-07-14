# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

FROM deps AS web-build
COPY web ./web
RUN npm run build -w web

FROM deps AS server-build
COPY server ./server
RUN npm run build -w server

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev --workspace=@tyflix/server
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=web-build /app/web/dist ./web/dist
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
