# Mise — Implementation Plan

The work queue for the MVP. Source of truth for scope and data model is
`docs/spec.md`; dev loop and conventions are in `CLAUDE.md`. Tasks are ordered
for sequential execution — pick the next unchecked one and respect `depends-on`.

**Status legend:** `[ ]` todo · `[~]` in progress · `[r]` review · `[x]` done

Milestone cut follows the spec's daily loop in dependency order (scaffold → auth
→ data → work → capture → plan → review). Two deliberate notes, both inline: the
initial migration excludes `DailyPlan`/`PlanBlock` (spec defers that migration
to the planning milestone, so M1-T4 comments those models out and M6-T1 restores
them), and rollover needs a `User.lastRolloverOn` date column the base schema
lacks, so M3-T3 carries a small migration of its own.

---

## M1 — Scaffolding, tooling, deploy pipeline

- [x] **M1-T1 — Workspace wiring and root tooling config**
  - depends-on: —
  - files: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `.npmrc`
  - done 2026-11-02 — Node pin deferred to M1-T7, which added `engines.node`;
    the `.npmrc` decision was settled in M1-T8, see that task's note.
    Review notes: base config sets `noEmit`, so M1-T2/M1-T7 child
    configs must set `"noEmit": false` to emit; M1-T5's web config must
    override both `module` and `moduleResolution` (and add DOM to `lib`).
  - accept:
    - `npm install` from the repo root installs all four workspaces (`apps/web`, `apps/api`, `apps/db`, `packages/shared`) with no errors.
    - `tsconfig.base.json` defines strict TS settings and path aliases that both apps extend.
    - `.env.example` stays in sync with what the code reads (`DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `ALLOWED_EMAILS`, `TOKEN_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `WEB_ORIGIN`, `PORT`) with placeholder values; no real secrets.

- [x] **M1-T2 — `packages/shared` package scaffold** — done 2026-11-02
  - depends-on: M1-T1
  - files: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
  - accept:
    - Package builds to typed output and exports a single barrel from `src/index.ts`.
    - Both `apps/api` and `apps/web` can import a sample exported type and typecheck cleanly.

- [x] **M1-T3 — Express app shell with exported app and health route** — done 2026-11-02
  - depends-on: M1-T2
  - files: `apps/api/package.json`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/health.ts`
  - note: `apps/api/src/routes/health.test.ts` landed here via the dev loop's
    test-writer step; M1-T6 only adds root orchestration + vitest config for it.
    Review carry-over for M2: `app.ts` still needs a JSON 404 fallthrough and a
    central error handler (no owning task yet) before the first real route.
  - accept:
    - `app.ts` exports a configured Express app with no `listen` call; `server.ts` is the only place that listens, and it is not imported by the app module.
    - `GET /api/health` returns `200` with a JSON body including status and uptime.
    - A supertest-style request against the exported app passes without a running server.

- [x] **M1-T4 — `apps/db` package: Prisma client setup and initial migration** — done 2026-11-02
  - depends-on: M1-T3
  - files: `apps/db/package.json`, `apps/db/tsconfig.json`, `apps/db/prisma/schema.prisma`, `apps/db/prisma/migrations/`, `apps/db/src/index.ts`
  - note: M1-T4 lands the `@mise/db` workspace dependency in
    `apps/api/package.json`; the actual `import` from `apps/api` is deferred to
    M2-T1, which adds the first route that queries the database.
  - accept:
    - `DailyPlan` and `PlanBlock` are commented out in `schema.prisma` with a `// restored in M6-T1` marker; the initial migration creates every other model and enum.
    - `npx prisma migrate dev` in `apps/db` applies cleanly against a fresh database; `npx prisma migrate deploy` is idempotent.
    - A single shared `PrismaClient` singleton is exported from the `apps/db` package and imported by `apps/api` as a workspace dependency (no client-per-request, no direct `@prisma/client` import from `apps/api`).

- [x] **M1-T5 — Vite + React + Tailwind app shell** (parallel-ok with M1-T4) — done 2026-11-02
  - depends-on: M1-T2
  - files: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/index.css`, `apps/web/src/api/client.ts`
  - accept:
    - `npm run dev -w apps/web` serves the app; Tailwind utility classes take effect.
    - Vite dev server proxies `/api/*` to the local API port.
    - A shared `fetch` wrapper exists that sends credentials and surfaces non-2xx responses as typed errors.
  - note: no `apps/web/tailwind.config.ts` — Tailwind v4 is config-free, wired
    via the `@tailwindcss/vite` plugin plus `@import "tailwindcss";` in
    `src/index.css`. The proxy target is env-driven via
    `VITE_API_PROXY_TARGET`, defaulting to `http://localhost:3000` when unset.

- [x] **M1-T6 — Lint, format, and test tooling across workspaces** — done 2026-11-02
  - depends-on: M1-T3, M1-T5
  - files: `eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`, `apps/web/src/App.test.tsx`, `apps/api/src/routes/health.test.ts`
  - note: config file is `eslint.config.mjs`, not `.js` as planned — root
    `package.json` stays CJS (no `"type": "module"`), so the flat config
    needs the `.mjs` extension to load as ESM. Type-aware linting
    (`parserOptions.project`) was deliberately deferred to a follow-up task.
  - accept:
    - `npm run lint` and `npm test` from the root run across all workspaces and exit `0`.
    - At least one real API test (health route, via the exported app) and one web component test run under Vitest.

- [x] **M1-T7 — Vercel + Neon deploy pipeline** — done 2026-11-03
  - depends-on: M1-T4, M1-T6
  - files: `vercel.json`, `api/index.ts`, `api/package.json`, `api/tsconfig.json`, `.vercelignore`
  - accept:
    - The Vercel Function entry imports the exported Express app and wraps it; no duplicate app construction per request.
    - A deployed preview serves the web build at `/` and `GET /api/health` returns `200` against Neon.
    - Migrations run via `prisma migrate deploy` in the build step, not `db push`.
    - `schema.prisma` gains `directUrl = env("DIRECT_URL")`: runtime uses the pooled Neon URL (`DATABASE_URL`), migrations use the direct one; both set in Vercel env and listed in `.env.example`.
  - deviations:
    - Function entry lives at repo-root `api/index.ts` (not `apps/api/api/index.ts`) — Vercel only discovers functions under `api/` at the project root, and the root must be the repo root for same-origin web+API. `api/` has its own `package.json` (`type: module`; Vercel's builder keeps ESM syntax and Node needs the nearest package.json to say so) and `tsconfig.json`.
    - Migrations are gated to production builds: `vercel-build` runs compile-only `build` then `migrate:deploy` only when `VERCEL_ENV=production`, as the last step. Reviewer finding — previews share the prod `DATABASE_URL`, so an ungated migrate let any preview deploy mutate the prod schema. Preview builds log an explicit skip line.
    - `.vercelignore` added: `vercel deploy` uploads the working directory without applying `.gitignore` (observed: `apps/db/.env`, `dist/` in the first deployment's sources; that deployment was deleted).
    - Project `mise-planner` on Vercel; prod alias `mise-planner-dusky.vercel.app`. First deployment on a fresh project is forcibly Production (Vercel rule) — approved by Savan 2026-11-03.

- [x] **M1-T8 — Update CLAUDE.md command table and dev scripts** — done 2026-11-03
  - depends-on: M1-T7
  - files: `CLAUDE.md`, `package.json`, `package-lock.json`, `.nvmrc`
  - note: root `dev` runs both servers via `concurrently -k` (prefixed,
    color-coded; one `Ctrl-C` kills both). `engines.node` relaxed from `22.x`
    to `>=22` — local Node is v25.2.1. `.nvmrc` added with `22.22.2` as the
    reference version (the dependency tree's actual floor: jsdom requires
    `^22.22.2`).
  - deviations:
    - `.npmrc` with `engine-strict=true` was planned but **not** created: it
      gates the whole dependency tree, not just this package. Five installed
      packages declare engines that exclude current non-LTS lines, 23/25 (`vitest`,
      `jsdom`, `@asamuzakjp/css-color`, `@asamuzakjp/dom-selector`,
      `w3c-xmlserializer` — all `^22.22.2 || ^24.15.0 || >=26.0.0`-shaped), so
      strict mode fails `npm install` on Node 25 regardless of our own
      `engines` value. Zero conflicts under Node 22.22.2 or 26. Decision:
      Savan approved dropping `engine-strict` because vitest/jsdom engines
      exclude Node 25; no open item remains.
    - Verification substitutions: `npm run migrate:dev -w @mise/db` and
      `npm run migrate:deploy -w @mise/db` were verified read-only, via
      `npx prisma migrate status` against local `mise_dev` — the mutating
      commands themselves were not run. `npx vercel deploy` was documented
      in the command table but not run; Savan runs deploys himself.
    - Relaxing `engines.node` to `>=22` changes the Node version Vercel
      builds with: `engines` overrides the dashboard setting, so the next
      build resolves to the newest matching major, not pinned `22.x`. The
      next preview deploy (Savan's to run) should confirm `/api/health`
      still works under whatever Node version that resolves to.
  - accept:
    - `npm run dev` starts web and API together; the command table in `CLAUDE.md` lists the real commands with no remaining `(placeholder)` markers.
    - Every command listed in the table has been run and succeeds.

- [ ] **M1-T9 — Type-aware ESLint rules (projectService)**
  - depends-on: M1-T6
  - files: `eslint.config.mjs`, `tsconfig.json` (or a root-level config tsconfig)
  - accept:
    - `tseslint.configs.recommendedTypeChecked` (or equivalent) is enabled via `languageOptions.parserOptions.projectService`, with a tsconfig story covering root-level config files (`eslint.config.mjs`, `vitest.config.ts`, etc.) that aren't part of an app's own `tsconfig.json`.
    - `npm run lint` still exits `0`, or any findings it surfaces in existing code are fixed minimally and reported.

---

## M2 — Auth (Google OAuth, sessions, token encryption)

- [ ] **M2-T1 — AES-GCM token encryption module [review: line-by-line]**
  - depends-on: M1-T4
  - files: `apps/api/src/crypto/tokenCrypto.ts`, `apps/api/src/crypto/tokenCrypto.test.ts`
  - accept:
    - Single module exporting `encrypt`/`decrypt`; key read from `TOKEN_ENCRYPTION_KEY` and validated at startup (fail fast on missing/short key).
    - Ciphertext carries a random IV and auth tag; tampering with any stored component makes `decrypt` throw rather than return plaintext.
    - Round-trip, tamper-detection, and wrong-key tests pass; no plaintext or key material appears in any log or error message.

- [ ] **M2-T2 — Postgres-backed session middleware [review: line-by-line]**
  - depends-on: M1-T4
  - files: `apps/api/src/auth/session.ts`, `apps/api/src/app.ts`
  - accept:
    - `express-session` + `connect-pg-simple` configured; the session table is created by the library and is absent from `schema.prisma`.
    - Cookie is `httpOnly`, `sameSite=lax`, `secure` in production, with an explicit `maxAge`; `trust proxy` set so cookies work behind Vercel.
    - `SESSION_SECRET` is required at startup; a test confirms a `Set-Cookie` with the expected flags.

- [ ] **M2-T3 — Passport Google strategy with email allowlist [review: line-by-line]**
  - depends-on: M2-T1, M2-T2
  - files: `apps/api/src/auth/passport.ts`, `apps/api/src/auth/allowlist.ts`, `apps/api/src/auth/allowlist.test.ts`
  - accept:
    - `passport-google-oauth20` configured with Calendar read scope plus `offline` access and consent prompt so a refresh token arrives.
    - Verify callback rejects any email not in `ALLOWED_EMAILS` (case-insensitive, trimmed) before any DB write; allowed emails upsert a `User`.
    - Serialize/deserialize store only the user id; tests cover allowed, disallowed, and empty-allowlist cases.

- [ ] **M2-T4 — Auth routes: sign-in, callback, logout, me [review: line-by-line]**
  - depends-on: M2-T3
  - files: `apps/api/src/routes/auth.ts`, `apps/api/src/routes/auth.test.ts`
  - accept:
    - `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/logout`, `GET /api/me` behave as expected; logout destroys the session row and clears the cookie.
    - Rejected (non-allowlisted) sign-in redirects to the web app with an error flag and creates no session.
    - No route logs tokens, profile payloads, or email addresses.

- [ ] **M2-T5 — `requireAuth` middleware and userId scoping [review: line-by-line]**
  - depends-on: M2-T4
  - files: `apps/api/src/auth/requireAuth.ts`, `apps/api/src/app.ts`, `packages/shared/src/auth.ts`
  - accept:
    - All `/api/*` routes except `/api/health` require an authenticated session and return `401` otherwise.
    - The middleware attaches a typed `userId` to the request; downstream handlers have no way to read a userId from the client.
    - Tests cover authed and unauthed access to a protected route.

- [ ] **M2-T6 — Integration row storage for Google tokens [review: line-by-line]**
  - depends-on: M2-T1, M2-T3
  - files: `apps/api/src/services/integrations.ts`, `apps/api/src/services/integrations.test.ts`
  - accept:
    - On successful sign-in, tokens are encrypted and upserted on the `@@unique([userId, provider, accountEmail])` key; re-login updates rather than duplicates.
    - A missing refresh token on re-consent does not overwrite a previously stored one with `null`.
    - Reads are always filtered by `userId`; tests assert a cross-user read returns nothing.

- [ ] **M2-T7 — Web sign-in / sign-out and auth-gated routing [review: line-by-line]**
  - depends-on: M2-T4, M2-T5
  - files: `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/pages/SignIn.tsx`, `apps/web/src/App.tsx`
  - accept:
    - Unauthenticated users see the sign-in screen; authenticated users see the app shell, resolved from `GET /api/me` on load.
    - A `401` from any API call returns the user to the sign-in screen.
    - Sign-out clears client state and the server session; the allowlist-rejection error is shown as readable copy.

---

## M3 — Tasks CRUD and lazy rollover

- [ ] **M3-T1 — Shared task contracts and request validation**
  - depends-on: M2-T5
  - files: `packages/shared/src/task.ts`, `apps/api/src/routes/tasks.schema.ts`
  - accept:
    - Task DTOs, `TaskStatus`/`TaskSource`/priority types, and create/update payload shapes are exported from `packages/shared` and used by both apps.
    - Validation rejects unknown fields, out-of-range priority, and non-positive `estimateMin`, returning `400` with a field-level message.

- [ ] **M3-T2 — Task service and CRUD routes**
  - depends-on: M3-T1
  - files: `apps/api/src/services/tasks.ts`, `apps/api/src/routes/tasks.ts`, `apps/api/src/routes/tasks.test.ts`
  - accept:
    - `GET/POST /api/tasks`, `PATCH/DELETE /api/tasks/:id` work; list supports filtering by status and sorts by priority then `dueAt`.
    - Every query includes `userId` in its `where`; a task belonging to another user returns `404`, not `403` or the row.
    - Tests cover create, list filtering, update (including status transition to `DONE`), delete, and cross-user isolation.

- [ ] **M3-T3 — Lazy day rollover with deferCount**
  - depends-on: M3-T2
  - files: `apps/db/prisma/schema.prisma`, `apps/db/prisma/migrations/`, `apps/api/src/services/rollover.ts`, `apps/api/src/auth/requireAuth.ts`, `apps/api/src/services/rollover.test.ts`
  - accept:
    - Adds `User.lastRolloverOn DateTime? @db.Date` via a Prisma migration (no hand edits, no `db push`).
    - On the first authenticated request of a new local day, unfinished (`TODO`/`IN_PROGRESS`) tasks increment `deferCount` once and `lastRolloverOn` advances; a second request the same day is a no-op.
    - Rollover runs in a transaction and is skipped entirely for days the app wasn't opened (no catch-up multi-increment).

- [ ] **M3-T4 — Web task list screen** (parallel-ok with M4-T1)
  - depends-on: M3-T2
  - files: `apps/web/src/pages/Tasks.tsx`, `apps/web/src/api/tasks.ts`, `apps/web/src/components/TaskRow.tsx`
  - accept:
    - Tasks render grouped by status with inline create, edit, complete, and delete; optimistic updates roll back on API error.
    - `deferCount > 0` is visible on the row; estimate and project are shown when present.

---

## M4 — Multi-task Pomodoro

- [ ] **M4-T1 — Shared session contracts**
  - depends-on: M3-T1
  - files: `packages/shared/src/session.ts`, `apps/api/src/routes/sessions.schema.ts`
  - accept:
    - Types for session start (plannedMin, taskIds), active-session state, segment switch, and end payload (per-task outcome + note) are exported and consumed by both apps.
    - Validation rejects empty task lists, unknown `plannedMin` values outside {25, 50, 90, custom-positive}, and duplicate taskIds.

- [ ] **M4-T2 — Session start service and route**
  - depends-on: M4-T1
  - files: `apps/api/src/services/sessions.ts`, `apps/api/src/routes/sessions.ts`, `apps/api/src/routes/sessions.test.ts`
  - accept:
    - `POST /api/sessions` creates the `Session`, one `SessionTask` per task, and an open `SessionSegment` for the first task, in a single transaction.
    - All referenced tasks are verified to belong to the caller; a foreign taskId fails the whole request with `404` and creates nothing.
    - Starting a session while another is open returns `409` rather than creating a second open session.

- [ ] **M4-T3 — Segment switching route**
  - depends-on: M4-T2
  - files: `apps/api/src/services/sessions.ts`, `apps/api/src/routes/sessions.ts`
  - accept:
    - `POST /api/sessions/:id/switch` closes the open segment with `endedAt` and opens one for the new task, atomically; exactly one segment is open afterward.
    - Switching to a task not in the session returns `400`; switching in an ended session returns `409`.
    - Tests assert segment timestamps are contiguous (previous `endedAt` equals next `startedAt`).

- [ ] **M4-T4 — Session end: outcomes, notes, even-split fallback**
  - depends-on: M4-T3
  - files: `apps/api/src/services/sessions.ts`, `apps/api/src/routes/sessions.ts`
  - accept:
    - `POST /api/sessions/:id/end` closes the open segment, sets `Session.endedAt`, and records `outcome` + `note` per `SessionTask`.
    - If no switch ever occurred and the session had multiple tasks, elapsed time is split evenly into one segment per task; the single-task case keeps its one segment unchanged.
    - Tasks marked `DONE` update the underlying `Task.status`; ending an already-ended session returns `409`.

- [ ] **M4-T5 — Active session resume and prior "where I left off" notes**
  - depends-on: M4-T4
  - files: `apps/api/src/routes/sessions.ts`, `apps/api/src/services/sessions.ts`
  - accept:
    - `GET /api/sessions/active` returns the open session with server `startedAt`, `plannedMin`, tasks, and the currently open segment — enough to rebuild the timer after a refresh.
    - Each task in the payload includes the most recent prior-session `note` for that task, or `null`.
    - Returns `204`/null cleanly when no session is open.

- [ ] **M4-T6 — Web Pomodoro timer screen**
  - depends-on: M4-T5
  - files: `apps/web/src/pages/Focus.tsx`, `apps/web/src/components/Timer.tsx`, `apps/web/src/api/sessions.ts`
  - accept:
    - Countdown is computed client-side from the server `startedAt`, so a refresh or tab restore shows the correct remaining time.
    - Task switcher calls the switch route and highlights the active task; extend adds time without creating a new session.
    - Prior "where I left off" note is visible for each task at session start.

- [ ] **M4-T7 — Web end-of-session outcome and notes modal**
  - depends-on: M4-T6
  - files: `apps/web/src/components/SessionEndDialog.tsx`
  - accept:
    - On timer completion or manual stop, each session task gets a done/partial/not-started choice and an optional note; submit calls the end route once.
    - If no task switching occurred with multiple tasks, the UI explains the even-split fallback before submitting.

---

## M5 — Brain-dump → Claude → editable preview → save

- [ ] **M5-T1 — Claude structured-output parsing service**
  - depends-on: M3-T1
  - files: `packages/shared/src/parsedTask.ts`, `apps/api/src/services/claudeParser.ts`, `apps/api/src/services/claudeParser.test.ts`
  - accept:
    - Service calls the Claude API with a tool/structured-output schema returning title, project, `estimateMin`, priority, and inferred `dueAt`; output is validated before returning.
    - Dump text, prompts, and API responses are never logged; failures surface a generic error.
    - Tests run against a mocked client and cover a valid parse, a schema-violating response, and an API error.

- [ ] **M5-T2 — Brain-dump parse route**
  - depends-on: M5-T1, M2-T5
  - files: `apps/api/src/routes/dump.ts`, `apps/api/src/routes/dump.test.ts`
  - accept:
    - `POST /api/dump/parse` accepts raw text, returns parsed candidate tasks, and persists nothing.
    - Input length cap and a simple per-user request guard return `400`/`429` instead of calling Claude.

- [ ] **M5-T3 — Bulk task save route**
  - depends-on: M5-T2, M3-T2
  - files: `apps/api/src/services/tasks.ts`, `apps/api/src/routes/tasks.ts`
  - accept:
    - `POST /api/tasks/bulk` creates all submitted tasks in one transaction with `source = DUMP` and the caller's `userId`.
    - A single invalid item rejects the whole batch with `400`; nothing is partially written.

- [ ] **M5-T4 — Web brain-dump screen with editable preview**
  - depends-on: M5-T3
  - files: `apps/web/src/pages/Dump.tsx`, `apps/web/src/components/ParsedTaskTable.tsx`, `apps/web/src/api/dump.ts`
  - accept:
    - Textarea → parse → editable preview table where every field can be changed and rows removed before saving.
    - Save posts the edited rows to the bulk route and lands on the task list showing the new tasks; parse errors are recoverable without losing the typed text.

---

## M6 — Google Calendar read and plan-my-day

- [ ] **M6-T1 — DailyPlan / PlanBlock migration**
  - depends-on: M1-T4
  - files: `apps/db/prisma/schema.prisma`, `apps/db/prisma/migrations/`
  - accept:
    - `DailyPlan` and `PlanBlock` are uncommented exactly as specified in `docs/spec.md` and a new migration creates both tables with the documented unique/index constraints.
    - `prisma migrate deploy` applies cleanly on top of the existing history; no earlier migration is edited.

- [ ] **M6-T2 — Google Calendar client and free-block computation [review: line-by-line]**
  - depends-on: M2-T6
  - files: `apps/api/src/services/googleCalendar.ts`, `apps/api/src/services/googleCalendar.test.ts`
  - accept:
    - Access token is decrypted through the single crypto module, refreshed on `401`, and the refreshed token is re-encrypted and persisted; decrypted tokens are never logged or returned from the service.
    - Busy events for the caller's day are fetched read-only and inverted into free blocks within configurable working hours, merging overlaps and dropping sub-minimum gaps.
    - Tests use a mocked Google client and cover refresh, all-day events, and a fully booked day.

- [ ] **M6-T3 — Day planning service**
  - depends-on: M6-T1, M6-T2
  - files: `apps/api/src/services/planner.ts`, `apps/api/src/services/planner.test.ts`
  - accept:
    - Fits unfinished tasks into free blocks ordered by due date, then priority, then `deferCount`, respecting `estimateMin` and leaving unplaceable tasks in an explicit overflow list.
    - Persists one `DailyPlan` per `userId`+date with ordered `PlanBlock` rows in a transaction; re-planning replaces blocks rather than duplicating them.
    - Tasks without an estimate get a documented default duration.

- [ ] **M6-T4 — Plan routes**
  - depends-on: M6-T3
  - files: `apps/api/src/routes/plan.ts`, `apps/api/src/routes/plan.test.ts`
  - accept:
    - `GET /api/plan/today` returns the stored plan (or null), `POST /api/plan/today` generates/regenerates it, `PATCH /api/plan/blocks/:id` adjusts a block's times or order.
    - All reads and writes are scoped by `userId`; another user's plan or block returns `404`.

- [ ] **M6-T5 — Web day-plan timeline** (parallel-ok with M7-T1)
  - depends-on: M6-T4
  - files: `apps/web/src/pages/Plan.tsx`, `apps/web/src/components/PlanTimeline.tsx`, `apps/web/src/api/plan.ts`
  - accept:
    - "Plan my day" generates and renders a timeline of blocks with calendar busy time shown as context; overflow tasks are listed separately.
    - A block can start a Pomodoro session for its task, and block times can be edited inline and persisted.

---

## M7 — End-of-day summary

- [ ] **M7-T1 — Summary service and route**
  - depends-on: M4-T4, M6-T1
  - files: `apps/api/src/services/summary.ts`, `apps/api/src/routes/summary.ts`, `apps/api/src/routes/summary.test.ts`
  - accept:
    - `GET /api/summary?date=` returns per-task planned minutes (from `PlanBlock`) vs actual minutes (summed from `SessionSegment`), task outcomes, completed/deferred counts, and unplanned time worked.
    - Open segments on the queried day are excluded or clamped to now, not counted as zero-length.
    - Scoped by `userId`; returns an empty-but-valid shape for a day with no data.

- [ ] **M7-T2 — Web end-of-day summary screen**
  - depends-on: M7-T1
  - files: `apps/web/src/pages/Summary.tsx`, `apps/web/src/api/summary.ts`
  - accept:
    - Shows planned vs actual per task with totals, completed/deferred counts, and the day's notes; a date picker loads prior days.

- [ ] **M7-T3 — MVP end-to-end verification and docs pass**
  - depends-on: M7-T2
  - files: `CLAUDE.md`, `docs/spec.md`, `.env.example`
  - accept:
    - The full loop (sign in → dump → plan → session → summary) is exercised against the deployed Vercel + Neon environment and the actual output is reported.
    - `docs/spec.md` MVP scope checkboxes are ticked; `.env.example` and the `CLAUDE.md` command table match what shipped.

---

## v2 (milestone level only — no task breakdown yet)

- **V2-M1 — Provider adapter layer:** common calendar/mail interfaces, multiple accounts per provider (`Integration` already models this), and cross-calendar event dedup.
- **V2-M2 — Gmail actionable-email detection:** scan connected Gmail accounts for actionable mail and surface suggested tasks.
- **V2-M3 — GitHub integration:** open PRs, review requests, and assigned issues become suggested tasks.
- **V2-M4 — Microsoft 365:** Outlook calendar and mail via Microsoft Graph (pending the admin-consent open question in `docs/spec.md`).
- **V2-M5 — Combined time-allocation view:** one view of committed time across every connected calendar.
