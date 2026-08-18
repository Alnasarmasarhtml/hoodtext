# @hoodgram/relay — production container.
#
# Build from the REPO ROOT, not from this directory:
#
#     docker build -f apps/relay/Dockerfile -t hoodgram-relay .
#
# The relay is a pnpm workspace member and imports `@hoodgram/crypto`, which
# publishes raw TypeScript (`"main": "./src/index.ts"`, no build output). There
# is therefore no compiled artifact to ship: `pnpm build` in this repo is
# `tsc --noEmit`, a type check that writes nothing. The relay runs its
# TypeScript directly through `tsx`, in production exactly as in development.
#
# Two consequences that are easy to get wrong:
#   1. `tsx` is a devDependency, so `--prod` installs MUST NOT be used. The
#      image would build and then fail at startup with "tsx: not found".
#   2. `packages/crypto` has to be present in the image. Its symlink resolves
#      to a real path outside node_modules, which is what lets tsx transpile it.
#
# node:sqlite is used for storage and needs Node >= 22. Pinned to 22 rather
# than latest so a Node release cannot change the database engine underneath a
# running deployment.
FROM node:22-alpine

# libsodium builds nothing here (libsodium-wrappers-sumo ships wasm), but
# better-sqlite-free native resolution and pnpm's lockfile check both want a
# predictable toolchain present.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy only what the relay's dependency graph needs, so a change to apps/web
# never invalidates this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/crypto/package.json ./packages/crypto/
COPY apps/relay/package.json ./apps/relay/

# Dev dependencies included on purpose: tsx is the runtime. See the note above.
RUN pnpm install --frozen-lockfile --filter @hoodgram/relay...

COPY packages/crypto ./packages/crypto
COPY apps/relay ./apps/relay

# The SQLite file must live on a mounted volume. Left on the container
# filesystem it is destroyed by every restart and redeploy, which silently
# throws away every stored ciphertext blob that clients have not yet fetched.
ENV RELAY_DB_PATH=/data/hoodgram.db \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8787 \
    NODE_ENV=production
VOLUME ["/data"]

EXPOSE 8787

# `/v1/health` answers without touching the chain, so it stays green while the
# indexer is catching up and reports `indexerLagBlocks` for the platform to read.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/v1/health >/dev/null || exit 1

WORKDIR /app/apps/relay
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
