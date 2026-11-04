# Linux + Xvfb environment for the Electron browser checks, matching the
# "Full browser suite (Linux)" CI step. Run it with `npm run test:browser:docker`.
FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    xvfb xauth git \
    libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libatk-bridge2.0-0 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libcups2 libsecret-1-0 \
    fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Tells the browser-check scripts they may open windows here.
ENV GNOSIS_IN_DOCKER=1
WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies are cached until the lockfile changes.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node resources/mergiraf/manifest.json resources/mergiraf/COPYING resources/mergiraf/NOTICE.md resources/mergiraf/
COPY --chown=node:node scripts/prepare-mergiraf.mjs scripts/
RUN npm run prepare:mergiraf

# Same SUID sandbox setup as CI, so Electron runs sandboxed as a non-root user.
USER root
RUN chown root:root node_modules/electron/dist/chrome-sandbox \
  && chmod 4755 node_modules/electron/dist/chrome-sandbox
USER node

COPY --chown=node:node . .
