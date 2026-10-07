# Job image: one disposable container per agent task. Run flags live in src/docker.ts.
# Build with the UID/GID of the user running agent-runner, so the mounted workdir is writable:
#   docker build -t hms-agent-job:latest --build-arg AGENT_UID=$(id -u agent-runner) --build-arg AGENT_GID=$(id -g agent-runner) job
FROM node:22-bookworm-slim AS node
FROM composer:2 AS composer
FROM php:8.4-cli-bookworm

ARG AGENT_UID=1000
ARG AGENT_GID=1000

# PHP extensions beyond the base image (all composer.lock platform reqs are built in): gd for dompdf images, zip for composer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip ca-certificates libpng-dev libjpeg62-turbo-dev libfreetype6-dev libzip-dev \
 && docker-php-ext-configure gd --with-jpeg --with-freetype \
 && docker-php-ext-install -j"$(nproc)" gd zip \
 && rm -rf /var/lib/apt/lists/*

COPY --from=composer /usr/bin/composer /usr/local/bin/composer
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && php -v && composer --version && node --version && npm --version && git --version

# Agent SDK (bundles the Claude Code binary) + job script: root-owned, read-only for the agent user.
WORKDIR /opt/agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY run-job.mjs ./

RUN groupadd -g "${AGENT_GID}" agent && useradd -m -u "${AGENT_UID}" -g "${AGENT_GID}" -s /bin/bash agent
USER agent
ENV HOME=/home/agent \
    CI=true \
    COMPOSER_NO_INTERACTION=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /work/repo
ENTRYPOINT ["node", "/opt/agent/run-job.mjs"]
