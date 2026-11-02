# Mise — Spec

> Reference for agents working on this repo. Derived from `docs/mise-spec-export.md`
> (the original export, kept for history); **this file is the working source of truth.**

## Overview

**Mise** (from _mise en place_) — "Everything in its place before your day begins."

A personal task manager that turns a messy morning brain-dump into a realistic,
time-blocked day, then helps work through it with multi-task Pomodoro sessions.
Single user (the owner) for now; every table carries `userId` so multi-user needs
no migration later. Web only, deployed on free tiers so it's usable daily from
any device.

Pomodoro sessions double as automatic time-tracking — segments are the data that
makes estimate correction and personalization possible later.

## Daily loop

1. **Brain-dump** — type everything on your mind in plain language.
2. **Parse** — Claude (structured output) turns it into tasks: title, project,
   estimated duration, priority, inferred deadline. Editable before saving.
3. **Plan** — read Google Calendar free blocks; propose a time-blocked day
   (`DailyPlan` + `PlanBlock`) that fits the real gaps.
4. **Work** — Pomodoro sessions (25/50/90 min, extendable) over one or more
   tasks. Switching tasks mid-session closes one `SessionSegment` and opens
   another. Each task ends the session as done / partial / not started, with a
   "where I left off" note shown next session. Timer runs client-side; start/end
   persist server-side so refresh doesn't lose it.
5. **Review** — end-of-day summary of planned vs. actual.

**Rollover:** on the first API hit of a new day (lazy — no cron), unfinished
tasks roll forward and `deferCount` increments. Days the app isn't opened don't
count as deferrals. Implementation note: this needs a `User.lastRolloverOn
DateTime? @db.Date` column (not in the base schema below); it lands via its own
migration in the rollover task (plan.md M3-T3).

**Multi-task session fallback:** if the user never switches tasks, split time
evenly across the session's tasks, or prompt for a rough split at the end.

## MVP scope

- [ ] Auth: Google sign-in, email allowlist, Postgres-backed cookie sessions
- [ ] Tasks CRUD, with lazy rollover incrementing `deferCount`
- [ ] Multi-task Pomodoro: sessions, segments, outcomes, "where I left off" notes
- [ ] Brain-dump → Claude structured output → editable task list → save
- [ ] Google Calendar read + "plan my day" time-blocking
- [ ] End-of-day summary (planned vs. actual)

## v2 scope (milestone level only)

- Provider adapter layer: common calendar/mail interfaces; multiple accounts per
  provider (`Integration` already models this); cross-calendar event dedup
- Gmail actionable-email detection → suggested tasks (all connected accounts)
- GitHub: open PRs, review requests, assigned issues → suggested tasks
- Microsoft 365 (Outlook calendar + mail) via Microsoft Graph
- Combined time-allocation view across every connected calendar

## Non-goals (MVP)

- No Gmail, GitHub, or Microsoft integrations; no multiple accounts per provider
  (the schema supports them; no UI or sync code)
- No multi-user product surface (no signup, no sharing) — allowlist only
- No native/mobile apps, no offline mode, no push notifications
- No two-way calendar sync (read-only Calendar access)
- No analytics beyond the end-of-day summary (heatmaps, estimate correction,
  energy curves are "later ideas")
- No background jobs/cron — rollover is lazy on first request of the day

## Data model

Live schema: `apps/db/prisma/schema.prisma`. Sessions and segments are the most
valuable tables — estimate correction and best-hours analysis come from them.

Deltas from the original export (established as project conventions):

- `DailyPlan` + `PlanBlock` designed upfront (the export deferred them);
  migration still lands with the planning milestone.
- Every model has `createdAt` + `updatedAt`.
- Every FK scalar has an index (via `@@index` or a leading position in a
  `@@unique`); `onDelete` is explicit on every relation.
- The `express-session` store table (`connect-pg-simple`) lives **outside**
  Prisma — created by that library, never modeled in the schema.

```prisma
model User {
  id           String        @id @default(cuid())
  email        String        @unique
  name         String?
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
  tasks        Task[]
  sessions     Session[]
  integrations Integration[]
  dailyPlans   DailyPlan[]
}

model Task {
  id           String           @id @default(cuid())
  userId       String
  user         User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  title        String
  project      String?
  estimateMin  Int?
  priority     Int              @default(2)
  dueAt        DateTime?
  status       TaskStatus       @default(TODO)
  source       TaskSource       @default(DUMP)
  deferCount   Int              @default(0) // times rolled to the next day
  createdAt    DateTime         @default(now())
  updatedAt    DateTime         @updatedAt
  sessionTasks SessionTask[]
  segments     SessionSegment[]
  planBlocks   PlanBlock[]

  @@index([userId, status]) // task list: "my tasks by status"
}

enum TaskStatus { TODO IN_PROGRESS DONE DROPPED }
enum TaskSource { DUMP GITHUB GMAIL OUTLOOK MANUAL }

model Session {
  id         String           @id @default(cuid())
  userId     String
  user       User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  plannedMin Int
  startedAt  DateTime
  endedAt    DateTime?
  createdAt  DateTime         @default(now())
  updatedAt  DateTime         @updatedAt
  tasks      SessionTask[]
  segments   SessionSegment[]

  @@index([userId, startedAt]) // end-of-day summary: a user's sessions for a date
}

// Which tasks were in a session, how each ended, and where I left off
model SessionTask {
  sessionId String
  taskId    String
  session   Session      @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  task      Task         @relation(fields: [taskId], references: [id], onDelete: Cascade)
  outcome   TaskOutcome?
  note      String?      // "where I left off", shown next session
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  @@id([sessionId, taskId])
  @@index([taskId])
}

enum TaskOutcome { DONE PARTIAL NOT_STARTED }

// Time actually spent on each task within a session
model SessionSegment {
  id        String    @id @default(cuid())
  sessionId String
  taskId    String
  session   Session   @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  task      Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)
  startedAt DateTime
  endedAt   DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([sessionId])
  @@index([taskId])
}

// One plan per user per local day
model DailyPlan {
  id        String      @id @default(cuid())
  userId    String
  user      User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  date      DateTime    @db.Date
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
  blocks    PlanBlock[]

  @@unique([userId, date])
}

// An ordered, time-boxed slot for a task within a day's plan
model PlanBlock {
  id             String    @id @default(cuid())
  planId         String
  plan           DailyPlan @relation(fields: [planId], references: [id], onDelete: Cascade)
  taskId         String
  task           Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)
  scheduledStart DateTime
  scheduledEnd   DateTime
  sortOrder      Int
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([planId])
  @@index([taskId])
}

// One row per connected account; several per provider allowed
model Integration {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider        Provider
  accountEmail    String    // which account, e.g. personal vs school
  label           String?   // display name, e.g. "School"
  accessTokenEnc  String
  refreshTokenEnc String?
  scopes          String
  lastSyncedAt    DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([userId, provider, accountEmail])
}

enum Provider { GOOGLE GITHUB MICROSOFT }
```

## Auth design

- Google sign-in via **Passport** (`passport-google-oauth20`); one login covers
  identity and the Calendar consent.
- Sessions: httpOnly cookie, `express-session` + `connect-pg-simple` (Postgres
  store). No JWTs.
- **Email allowlist** (`ALLOWED_EMAILS` env var) — only listed accounts may sign in.
- OAuth access/refresh tokens encrypted at rest with **AES-GCM**; key from
  `TOKEN_ENCRYPTION_KEY` env var. Stored in `Integration.accessTokenEnc` /
  `refreshTokenEnc`.
- Google Cloud app stays in **testing mode** with the owner as test user —
  avoids the restricted-scope security review.
- Every query scoped by `userId`, always.

## Stack

| Layer        | Choice                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| Language     | TypeScript end-to-end                                                      |
| Frontend     | React + Vite + Tailwind CSS (`apps/web`)                                   |
| API          | Express + Node (`apps/api`), exported app wrapped for Vercel Functions     |
| Database     | Postgres (Neon) + Prisma (`apps/db`: schema, migrations, client singleton) |
| LLM parsing  | Claude API with tool use / structured output                               |
| Auth         | Google OAuth via Passport, Postgres-backed cookie sessions                 |
| Shared types | `packages/shared` (API contracts, parsed-task shape)                       |

## Hosting

- **Vercel Hobby**: `apps/web` as a static Vite build, `apps/api` as Vercel
  Functions wrapping the Express app.
- **Neon** free Postgres.
- Repo public on GitHub: secrets only in env vars, committed `.env.example`,
  push protection on.

## Decisions

- **Name:** Mise (_mise en place_). Repo `mise-planner` (`mise` collides with the dev tool).
- **Hook:** "Everything in its place before your day begins."
- **TypeScript** end-to-end (decided 2026-11-02).
- **Layout:** npm workspaces — `apps/web`, `apps/api`, `apps/db` (Prisma lives
  outside the API package), `packages/shared` (decided 2026-11-02).
- **DailyPlan/PlanBlock designed upfront**, migration deferred to the planning
  milestone (decided 2026-11-02).
- **Rollover is lazy** — first API request of a new day triggers it; no cron
  (decided 2026-11-02).
- Platform: web only. Hosting: free tiers only.

## Open questions

- Will the school Microsoft 365 tenant allow third-party apps to read mail and
  calendar, or does it require admin consent? Check via Graph Explorer before
  building v2.

## Later ideas (not scoped)

Project time allocation, focus heatmap, estimate correction, energy curve,
deferral prompt at 3+ deferrals, auto-breakdown of vague tasks, overflow
handling, backward planning from deadlines, two-way calendar sync, auto-complete
on PR merge, capture-from-anywhere (hotkey / iOS Shortcut / MCP), focus-mode
notifications, learned Pomodoro length.
