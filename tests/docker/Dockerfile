# Needs the Mergiraf runtime as a named build context (--build-context mergiraf=…); build it with npm run test:browser:docker.
# Linux + Xvfb environment for the Electron browser checks, matching the
# "Full browser suite (Linux)" CI step. Run it with `npm run test:browser:docker`.

# Conflict preparation runs `git merge-tree --merge-base`, which needs Git 2.40 or newer. Bookworm has 2.39; CI's
# runners have a newer Git. Built once (the layer is cached) into /opt/git, ahead of the system Git on PATH.
FROM node:24-bookworm AS git
ARG GIT_VERSION=2.47.1
RUN curl -fsSL https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz | tar -xJ -C /tmp \
  && make -C /tmp/git-${GIT_VERSION} -j"$(nproc)" prefix=/opt/git NO_TCLTK=1 NO_GETTEXT=1 NO_PERL=1 NO_PYTHON=1 \
    all install >/dev/null

FROM node:24-bookworm
COPY --from=git /opt/git/ /opt/git/
ENV PATH=/opt/git/bin:$PATH

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
# test-browser-docker.mjs prepares the Linux runtime for this architecture on the host and passes it as the
# `mergiraf` build context. Its version stamp matches, so prepare:mergiraf keeps it and does not download.
COPY --chown=node:node --from=mergiraf . resources/mergiraf/runtime/
RUN npm run prepare:mergiraf

# Same SUID sandbox setup as CI, so Electron runs sandboxed as a non-root user.
USER root
RUN chown root:root node_modules/electron/dist/chrome-sandbox \
  && chmod 4755 node_modules/electron/dist/chrome-sandbox
USER node

COPY --chown=node:node . .
