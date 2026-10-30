# OurHomeInbox image. Built from the repo root (see docker-compose.yml);
# Dockerfile.dockerignore keeps .env, config.yml and captured mail out of it.
#
# Settings are never baked in: .env arrives as environment variables and
# config.yml is mounted at /app/config.yml when the container runs.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production \
    OURHOMEINBOX_CONFIG=/app/config.yml
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Captured mail. docker-compose.yml mounts the repo's data/ folder here.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
# The web page and API (the port is web.port in config.yml).
EXPOSE 8080
CMD ["node", "dist/index.js", "serve"]
