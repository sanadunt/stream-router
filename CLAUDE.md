# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Camera Integration" (package name `stream-router`): a single-server camera control plane. Topology is **Camera → MediaMTX → (local WebRTC + fMP4 recording) → FFmpeg online relay → RTMP/RTMPS (VPS)**. MediaMTX pulls each camera exactly once; FFmpeg is only spawned for online relay. Node is the orchestrator, never the media path.

README, docs, UI strings, API error messages, log messages and test names are in **Indonesian** — keep new user-facing text and test descriptions in Indonesian to match.

## Commands

npm workspaces only (no pnpm/yarn). Node ≥ 20. Run everything from the repo root.

```bash
npm run dev               # predev: create/complete .env, download MediaMTX (SHA-256 verified) to .runtime/, apply migrations; then MediaMTX + API (tsx watch) + Vite concurrently
npm run lint              # eslint, --max-warnings=0
npm run typecheck         # all workspaces
npm test                  # unit: packages/ffmpeg/tests + apps/api/tests/unit, then web vitest
npm run test:integration  # apps/api/tests/integration (fake FFmpeg + fake MediaMTX HTTP server)
npm run build             # packages → web → api
npm run smoke             # real FFmpeg on a 2s lavfi stream
npm run verify:source     # grep-based security contract check (see below)
npm run verify:dist       # after build: boots apps/api/dist/server.js (production, temp DB, MediaMTX off) until /api/health answers
npm run verify:env        # after build: validates .env against the API's real env schema (field names only)
npm run db:migrate        # custom SQLite migration runner (prisma:migrate / prisma:deploy are aliases)
npm run secrets:reencrypt # rotate APP_ENCRYPTION_KEY: re-encrypts every *Encrypted column (old key via hidden prompt; --dry-run)
npm run release:package -- 1.2.3   # release/stream-router-docker-1.2.3.zip (compose pinned to ghcr image, .env.example, Windows scripts)
docker build -t stream-router:local .  # production image (build fails if verify-dist cannot boot the server)
```

Single test file / single test (root has no vitest config; pass the path):

```bash
npm run build:packages && npx vitest run apps/api/tests/unit/core.test.ts -t "memvalidasi environment"
npx vitest run --root apps/web src/navigation.test.ts
```

Verification order: `lint` → `typecheck` → `test` → `test:integration` → `build` → `smoke` → `verify:source` → `verify:dist`. Only `verify:dist` executes the built output; vitest resolves imports through Vite, so Node-ESM-only failures (directory imports, missing `.js` suffix, e.g. `onvif/promises` must be imported as `onvif/promises/index.js`) pass everything else.

**`packages/*` are consumed from their `dist/`**, so after editing `packages/contracts` or `packages/ffmpeg` run `npm run build:packages` before API typecheck/tests will see the change (`test`, `typecheck`, `dev` and `build` already do this).

Dev ports: Vite `WEB_PORT` (5173) proxies `/api` to the API at `HOST:PORT` (3000) — both read the root `.env`. MediaMTX uses non-default ports: RTSP 18554, RTMP 11935, WebRTC 18889, playback 19996, Control API 19997.

## Layout

- `apps/api` — Fastify 5 + Prisma (SQLite). ESM, `NodeNext` — relative imports need the `.js` suffix.
- `apps/web` — React 18 + Vite. No router library: `App.tsx` switches on a `Page` union, and `navigation.ts#authorizedPage` gates pages by role. **Does not import `@stream-router/contracts`**; API response types are hand-mirrored in `src/types/index.ts`, so DTO changes must be updated there too.
- `packages/contracts` — Zod schemas + inferred types for every API input (routes, PTZ, MQTT broker, settings, Stream View). DB enum-like columns are plain `String` in SQLite; these schemas are the source of truth for allowed values.
- `packages/ffmpeg` — `buildFfmpegCommand` (allowlisted argv, returns `args` + `redactedArgs`) and URL/text redaction.
- `scripts/` — `.mjs` dev/ops tooling (env bootstrap, MediaMTX download/run, migrations, smoke, auth reset, recording hook).

## API architecture

`server.ts` loads root `.env`, validates it via `config/env.ts` (Zod; rejects `GANTI_DENGAN_*` placeholders), bootstraps role credentials, starts the recording manager, then `workerManager.bootRecovery()` restarts auto-start routes. `app.ts` registers each `modules/*/…-routes.ts` as a Fastify plugin and owns the shared error envelope `{ error: { code, message, details, requestId } }` — throw `AppError(code, message, status)` from `shared/errors.ts`; Zod errors become 400 `VALIDATION_ERROR`.

Key cross-module flow (a "route" = one camera, `StreamRoute`):

- **`workers/worker-manager.ts`** is the singleton supervisor. Per-route operations are serialized through a promise queue (`enqueue`) so a route never gets duplicate workers. `start` → `ensureMediaRoute` (MediaMTX path must become READY) → start MQTT bridge → spawn FFmpeg only if `onlineRelayEnabled`. Two distinct retry regimes: a MediaMTX source that isn't READY is retried indefinitely with backoff (`scheduleMediaStartRetry`); FFmpeg relay crashes use the route's `retryPolicy.maxRetries` circuit breaker. A manual stop must cancel any pending retry. Status transitions are constrained by `workers/state-machine.ts`, and `RUNNING` must come from process/MediaMTX events, not timers.
- Anything that rewrites a route's MediaMTX path (start/stop, the 5 s media monitor's recovery, settings reapply, storage pause) runs inside that route's `enqueue` queue; Stop/Restart abort an in-flight READY wait. There is no global start lock: `maxWorkers` is enforced by an atomic slot reservation right before spawn. Media retries and relay retries keep separate counters (a recovered camera spawns FFmpeg at relay attempt 0), and Stop/manual Start bump a per-route generation so stale retries are dropped. Process shutdown stops only FFmpeg relays and MQTT bridges and leaves MediaMTX paths recording; `bootRecovery` closes stale `RouteRun` rows, deletes `cameras/*` paths not owned by an auto-start route, then starts auto-start routes with bounded concurrency.
- **`mediamtx/`** — `mediamtx-client.ts` talks to the MediaMTX Control API (`/v3/...`); `mediamtx-runtime.ts` maps routes to paths `cameras/{cameraKey}` (plus `cameras/{cameraKey}/webrtc` when Opus audio is needed, shared by local view and online relay), and `localWebrtcUrl` uses the env-only `MEDIAMTX_WEBRTC_PUBLIC_URL` (HTTPS reverse-proxy base, trailing `/` on purpose) instead of `http://publicHost:webrtcPort` when set; `mediamtx-config.ts` renders the global YAML atomically. Camera credentials go through the Control API, never into YAML. FFmpeg relay always reads from local MediaMTX RTSP, not the camera.
- **`recordings/`** — MediaMTX writes fMP4 segments and invokes `scripts/recording-segment-hook.mjs`, which POSTs to `/internal/mediamtx/segments` (loopback socket only, header token = HMAC of `AUTH_SECRET` from `mediamtxHookToken()`; the script derives the same value). A reconciler indexes anything missed; the manager creates its timers first and runs the initial pass in the background, so boot recovery never waits on it. Retention (days/GB per camera or inherited) and a storage-pressure guard with hysteresis live in `recording-service.ts`.
- **`events/event-bus.ts`** — in-process EventEmitter; `/api/events` streams it as SSE (`worker.status`, …). Web uses `useStreamEvents` with a 15s polling fallback.
- **`settings/settings-service.ts`** — runtime settings live in the `AppSetting` table (keys like `mediamtx.rtspPort`) and override env defaults. `mediamtx.publicHost` is stored only when it differs from the automatic value (`publicHostToStore`): empty/`auto`/loopback, a value equal to `MEDIAMTX_PUBLIC_HOST`, or the echoed fallback delete the row, so a Settings save never freezes `HOST_LAN_IP` into the DB. `GET /api/settings` returns the effective `publicHost` plus `publicHostConfigured`/`publicHostDefault`; the form round-trips only `publicHostConfigured`. A loopback `MEDIAMTX_PUBLIC_HOST` is honored (local-only mode); a loopback *stored* value means unset.
- **PTZ** (`ptz/`) supports ONVIF or MQTT per route or per standalone Stream View (`PtzTargetType` = `ROUTE` | `WEBRTC_STREAM`), with a per-camera queue and backend dead-man stop. **`mqtt-bridge/`** subscribes to broker topics and translates MQTT commands into ONVIF PTZ. **`onvif-discovery/`** is WS-Discovery multicast plus a one-camera-at-a-time inspect/import wizard.
- **`webrtc-streams/`** = "Stream View": standalone external players (IFRAME/WHEP/YouTube/HLS/MJPEG/MP4) independent of routes and workers.
- Route logs are JSONL files in `data/logs/{routeId}.log`, redacted on write via `redactText`.

Auth: three roles (`admin`, `operator`, `viewer` — viewer needs no password). HMAC-signed cookie `stream_router_session` carries a `credentialVersion` that must match the random `auth.<role>.credentialVersion` AppSetting; startup and login create it if missing, a missing row always rejects admin/operator sessions (viewer stays `'0'`), and changing a role's password bumps it to revoke sessions. `verifySession` also caps token lifetime server-side (`SESSION_TTL_SECONDS`) regardless of the signed `exp`. Guard routes with `requireAuth` / `requireRoles(...)` from `plugins/auth.ts`. Mutating requests from a foreign `Origin` are rejected in production.

In production an `onRequest` hook in `app.ts` rejects every request (GET, static files, login included) whose `Host` is not an IP literal, `localhost`, the `CORS_ORIGIN` host, the `MEDIAMTX_PUBLIC_HOST` host, or listed in `ALLOWED_HOSTS` (comma list) with `421 HOST_NOT_ALLOWED` — this is the DNS-rebinding defense, since viewer login needs no password. Login rate limit: admin/operator password attempts 5/min keyed by IP, or by the signed `stream_router_login_device` cookie (`modules/auth/login-device.ts`, path `/api/auth/login`, revoked with the role's `credentialVersion`) once a browser has logged in; viewer logins use a separate 60/min bucket. The bcrypt `trusted` lane is also granted by that cookie, never by IP (Docker Desktop shows every LAN client as one gateway IP).

## Invariants (enforced by `verify:source` and the spec)

- Spawn processes only via `spawn(executable, argsArray, { shell: false })`. `shell: true` and `execSync` fail `npm run verify:source`, which also requires certain literal tokens (e.g. `spawn(command.executable, command.args`, `redactedArgs`, the core route endpoint paths) to keep existing inside their owning module (`modules/workers/`, `modules/routes/`, … — see the `required` list in `scripts/verify-source.mjs`). Dot-directories such as `.claude/worktrees` are not scanned.
- Never accept arbitrary FFmpeg args from the API; add new options to `ffmpegOptionsSchema` and `command-builder.ts`.
- Stream URLs, outputs, PTZ config and broker passwords are AES-256-GCM encrypted at rest with `APP_ENCRYPTION_KEY` (`shared/crypto.ts`). DTOs only ever return masked URLs; redact before logging, not after.
- A new encrypted column must be named `*Encrypted` and added to `ENCRYPTED_COLUMNS` in `scripts/lib/encryption-rotation.mjs`, which duplicates the `crypto.ts` format so the rotation script runs without a build. `apps/api/tests/unit/encryption-rotation.test.ts` fails if the schema and that list drift, or if the two crypto implementations diverge.
- Private IPs are intentionally allowed for cameras; URL validation lives in `shared/url-policy.ts`.

## Database changes

Migrations are **not** run by `prisma migrate`. `scripts/apply-sqlite-migrations.mjs` executes `prisma/migrations/*/migration.sql` in name order and stores a SHA-256 checksum per migration in `_stream_router_migrations` — editing an already-applied migration aborts the runner. Each migration runs in one transaction with `PRAGMA foreign_keys=OFF` set beforehand (so table redefinitions keep child rows) and is rolled back if `PRAGMA foreign_key_check` reports violations. `apps/api/tests/integration/migration-runner.integration.test.ts` fails when the migrated schema drifts from `schema.prisma` (`prisma migrate diff`). For a schema change:

1. Edit `prisma/schema.prisma`.
2. Add a new `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` with hand-written SQLite DDL.
3. `npm run prisma:generate && npm run db:migrate`.
4. Update the raw `CREATE TABLE` / `ALTER TABLE` bootstrap in `apps/api/tests/integration/api.integration.test.ts` — the integration suite builds its own schema in `data/integration.db` rather than running migrations.

## Docker, Windows, and releases

- One container (`Dockerfile`, `docker-compose.yml`, image `ghcr.io/sanadunt/stream-router`, amd64+arm64): `tini` → `scripts/container-supervisor.mjs`, which bootstraps/persists `AUTH_SECRET`/`APP_ENCRYPTION_KEY` in `/app/data/secrets/stream-router.env` when not provided (values from env always win), runs migrations, and supervises `run-mediamtx.mjs` + `apps/api/dist/server.js` independently. Pure logic lives in `scripts/lib/container-supervisor-lib.mjs` (unit-tested).
- Volumes `/app/data` and `/recordings`. Published ports are fixed in compose (3000, 18889, 18189/udp, 18554, 18888, 11935, 18890/udp), so MediaMTX ports must not be changed from Settings in Docker. `HOST_LAN_IP` → `MEDIAMTX_PUBLIC_HOST`; `COOKIE_SECURE=auto` keeps LAN login over plain HTTP working. Opening the dashboard by hostname (Windows computer name, `.local`) needs that name in `ALLOWED_HOSTS` in `.env` (passed through by `env_file`); IP and `localhost` always work.
- `docker/.env.example` is the compose template (the root `.env.example` is the dev/PM2 one). In a repo checkout compose reads the same root `.env` as `npm run dev`.
- `docker/windows/*.ps1` must stay ASCII-only and Windows PowerShell 5.1 compatible (no `??`/ternary/`&&`; run native commands through the `Invoke-Native` helper so stderr isn't turned into terminating errors); never print secrets.
- CI/release: `.github/workflows/ci.yml` and `release.yml` (tag `v*.*.*` → GHCR multi-arch push + GitHub Release with the zip, an amd64 image tarball, and `SHA256SUMS.txt`). Docs: `docs/DOCKER.md`, `docs/WINDOWS.md` (shipped as `README-WINDOWS.md`).

## Notes

- `FILES.txt` is a stale file list; don't rely on it.
- `docs/SPECIFICATION.md` is the original build spec (MVP decisions, state machine, required tests); later features (MediaMTX, WebRTC, recording, roles) intentionally go beyond its non-goals.
- Production: `npm run build` then PM2 (`ecosystem.config.cjs`) serves `apps/web/dist` from the API; MediaMTX runs as a separate systemd service (`npm run media:install-service`). See `docs/DEPLOYMENT.md` and `docs/MEDIAMTX_RECORDING.md`.
