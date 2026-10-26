# syntax=docker/dockerfile:1

# Image Camera Integration (stream-router): dashboard + API, MediaMTX, dan FFmpeg dalam satu container.
# Dibangun multi-arch (linux/amd64, linux/arm64). Stage build sengaja berjalan di platform target
# (QEMU untuk arm64) agar engine Prisma, dependency native, dan binary MediaMTX cocok dengan image.
#
#   docker build -t stream-router .
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/<owner>/stream-router:<versi> --push .

ARG NODE_IMAGE=node:22-bookworm-slim
# SHA-256 arsip MediaMTX per arsitektur dipin untuk versi ini di scripts/ensure-mediamtx.mjs
# (PINNED_MEDIAMTX_SHA256). Versi lain tanpa pin di sana wajib membawa build-arg
# MEDIAMTX_SHA256_AMD64 dan/atau MEDIAMTX_SHA256_ARM64 sesuai platform yang dibangun.
ARG MEDIAMTX_VERSION=v1.19.2

FROM ${NODE_IMAGE} AS build
ARG MEDIAMTX_VERSION
ENV MEDIAMTX_VERSION=${MEDIAMTX_VERSION} \
    CHECKPOINT_DISABLE=1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# openssl: Prisma memilih engine dari versi libssl (debian-openssl-3.0.x / linux-arm64-openssl-3.0.x);
# image slim tidak membawa libssl sehingga tanpa paket ini Prisma menebak openssl-1.1.x.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/*

# Manifest dan schema lebih dulu agar layer npm ci (postinstall: prisma generate) tetap ter-cache
# selama dependency tidak berubah.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ffmpeg/package.json packages/ffmpeg/
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci

# Binary MediaMTX untuk arsitektur target. Arsip wajib cocok dengan SHA-256 terpin di repository
# (bukan sekadar checksums.sha256 dari release yang sama); build gagal untuk versi tanpa pin. Tidak
# bergantung pada source aplikasi sehingga tidak diunduh ulang setiap kode berubah.
ARG MEDIAMTX_SHA256_AMD64=
ARG MEDIAMTX_SHA256_ARM64=
COPY scripts/ensure-mediamtx.mjs scripts/
RUN MEDIAMTX_REQUIRE_SHA256=true node scripts/ensure-mediamtx.mjs

COPY . .
RUN npm run build

# Dependency dev dibuang. --omit=optional ikut membuang Prisma CLI dan TypeScript yang tertahan
# sebagai optional peer @prisma/client; client hasil generate di node_modules/.prisma tetap ada.
RUN npm prune --omit=dev --omit=optional --ignore-scripts \
 && test -f node_modules/.prisma/client/index.js \
 && ls node_modules/.prisma/client | grep -Eq '^libquery_engine-.+\.so\.node$' \
 && mkdir -p apps/api/node_modules packages/contracts/node_modules packages/ffmpeg/node_modules \
 && mkdir /out \
 && cp -a --parents \
      package.json \
      node_modules \
      apps/api/package.json apps/api/dist apps/api/node_modules \
      apps/web/package.json apps/web/dist \
      packages/contracts/package.json packages/contracts/dist packages/contracts/node_modules \
      packages/ffmpeg/package.json packages/ffmpeg/dist packages/ffmpeg/node_modules \
      prisma scripts .runtime \
      /out/

FROM ${NODE_IMAGE} AS runtime
ARG MEDIAMTX_VERSION
LABEL org.opencontainers.image.title="Camera Integration (stream-router)" \
      org.opencontainers.image.description="Control plane kamera: MediaMTX (WebRTC, recording fMP4) dan relay FFmpeg ke RTMP/RTMPS."

# ffmpeg Debian sudah membawa libx264, aac native, dan libopus (diverifikasi di bawah).
# tzdata: MediaMTX (Go) membaca TZ untuk nama folder/file recording.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg openssl tini tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && for encoder in libx264 aac libopus; do \
      ffmpeg -hide_banner -encoders 2>/dev/null | grep -Eq "^ [A-Z.]{6} ${encoder} " \
        || { echo "Encoder FFmpeg ${encoder} tidak tersedia" >&2; exit 1; }; \
    done

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_URL=file:/app/data/stream-router.db \
    MEDIAMTX_ENABLED=true \
    MEDIAMTX_VERSION=${MEDIAMTX_VERSION} \
    MEDIAMTX_CONFIG_PATH=data/mediamtx/mediamtx.yml \
    RECORDING_PATH=/recordings \
    COOKIE_SECURE=auto \
    TRUST_PROXY=false \
    CORS_ORIGIN=http://localhost:3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
# Kode milik root (read-only bagi user aplikasi); hanya data dan recording yang dapat ditulis.
COPY --from=build /out/ /app/
RUN "/app/.runtime/mediamtx/${MEDIAMTX_VERSION}/linux-$(dpkg --print-architecture)/mediamtx" --version \
 && mkdir -p /app/data /recordings \
 && chown node:node /app/data /recordings \
 && chmod 0750 /app/data \
 && chmod 0755 /recordings

USER node

# Boot dist/server.js production dengan env sementara: image yang tidak dapat berjalan gagal di sini,
# bukan di komputer pengguna. Sisa log di /app/data dihapus agar volume baru tetap kosong.
RUN node scripts/verify-dist.mjs \
 && find /app/data -mindepth 1 -delete

VOLUME ["/app/data", "/recordings"]

# Dashboard/API, WebRTC (WHEP + ICE UDP), RTSP, HLS, RTMP, SRT. Control API, playback, dan metrics
# MediaMTX hanya listen di 127.0.0.1 di dalam container.
EXPOSE 3000/tcp 18889/tcp 18189/udp 18554/tcp 18888/tcp 11935/tcp 18890/udp

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health', { signal: AbortSignal.timeout(4000) }).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

STOPSIGNAL SIGTERM
# tini (PID 1) meneruskan SIGTERM hanya ke supervisor; supervisor yang menghentikan API lalu MediaMTX.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "scripts/container-supervisor.mjs"]
