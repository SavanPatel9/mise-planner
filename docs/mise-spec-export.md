# Mise — Project Spec

Oct 26, 2026 · @Savan

## Overview

A personal task manager that turns a messy brain-dump into a realistic day, then helps me work through it with a Pomodoro timer. It's built for one user (me) first, and deployed so I can use it daily from any device.

The daily loop:

1. **Morning brain-dump** — type everything on my mind in plain language.
2. **Merge with context** — the app pulls in my calendar, GitHub, and actionable email.
3. **Plan** — it proposes a time-blocked day that fits my free time.
4. **Work** — I run Pomodoro sessions on one or more tasks at a time.
5. **Review** — end-of-day summary of planned vs. actual.

The Pomodoro sessions double as automatic time-tracking, which is the data that makes personalization possible later.

## Core features

Three pieces: capture, context, and execution.

### Brain-dump capture

- Free-text input: "finish Vercel app, prep for Harvey, groceries, fix the scraper"
- An LLM parses it into structured tasks: title, project, estimated duration, priority, inferred deadline
- Structured output (tool use / JSON schema), so results are validated, not free text
- I can edit anything it gets wrong before saving

### Context integrations

**MVP**

- **Google Calendar** — read free blocks so the plan only fills real gaps

**v2 — more context, more accounts**

- **Multiple accounts per provider** — for every integration type: several Google, Microsoft, or GitHub accounts side by side (e.g. personal and school). Events that appear on more than one calendar are deduplicated so time isn't counted twice
- **Gmail** — emails that look actionable (interview scheduling, recruiter replies) become suggested tasks
- **GitHub** — open PRs, review requests, and assigned issues surface as suggested tasks
- **Microsoft 365** — Outlook calendar and mail via Microsoft Graph
- **Provider adapters** — each source implements a common calendar or mail interface, so adding a new one doesn't touch planning logic

Calendars are what show where time goes; mail and GitHub mostly feed new tasks.

### Pomodoro timer

- Flexible lengths: 25, 50, or 90 minutes, extendable mid-session when in flow
- One or more tasks per session (see next section)
- Each session ends by marking tasks done, partial, or not started
- Timer runs client-side, but start/end are persisted server-side so a refresh doesn't lose it

## Multi-task sessions

A session can cover several tasks; **segments** record how the time actually split between them, so estimate data stays accurate.

1. Pick one or more tasks before starting. The first becomes active.
2. Tap another task mid-session to switch. This closes the current segment and opens a new one.
3. At the end, mark each task done, partial, or not started.

Fallback if I never switch: split time evenly across the session's tasks, or prompt for a rough split at the end.

- **SessionTask** — what was planned for the session and each task's outcome
- **SessionSegment** — where the minutes actually went

## Auth

Sign in with Google: one login covers identity and the Calendar/Gmail consent. Auth is required because the app is on a public URL and stores OAuth tokens that can read my email and calendar.

- **Passport** with `passport-google-oauth20` (or a hand-written OAuth flow)
- **Sessions** in an httpOnly cookie, backed by Postgres (`express-session` + `connect-pg-simple`), no JWTs
- **Email allowlist** so only my account can sign in
- **Encrypt refresh tokens** at rest (AES-GCM, key from an environment variable)
- **`userId` on every table**, so adding other users later needs no migration
- Keep the Google app in **testing mode** with me as a test user, which avoids the security review Gmail's restricted scopes require for public apps

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React + Tailwind CSS |
| API | Express + Node |
| Database | Postgres + Prisma |
| LLM parsing | Claude API with tool use / structured output |
| Auth | Google OAuth via Passport, Postgres-backed sessions |
| Integrations | MVP: Google Calendar (OAuth). v2: Gmail (multi-account), GitHub (OAuth app), Microsoft 365 via Microsoft Graph |
| Hosting | Vercel Hobby (frontend + Express as functions), Neon free Postgres |

## Data model

Sessions and segments are the most valuable tables: estimate correction and finding my best hours later both come from them.

```prisma
model User {
  id           String        @id @default(cuid())
  email        String        @unique
  name         String?
  createdAt    DateTime      @default(now())
  tasks        Task[]
  sessions     Session[]
  integrations Integration[]
}

model Task {
  id           String           @id @default(cuid())
  userId       String
  user         User             @relation(fields: [userId], references: [id])
  title        String
  project      String?
  estimateMin  Int?
  priority     Int              @default(2)
  dueAt        DateTime?
  status       TaskStatus       @default(TODO)
  source       TaskSource       @default(DUMP)
  deferCount   Int              @default(0) // times rolled to the next day
  createdAt    DateTime         @default(now())
  sessionTasks SessionTask[]
  segments     SessionSegment[]
}

model Session {
  id         String           @id @default(cuid())
  userId     String
  user       User             @relation(fields: [userId], references: [id])
  plannedMin Int
  startedAt  DateTime
  endedAt    DateTime?
  tasks      SessionTask[]
  segments   SessionSegment[]
}

// Which tasks were in a session, how each ended, and where I left off
model SessionTask {
  sessionId String
  taskId    String
  session   Session      @relation(fields: [sessionId], references: [id])
  task      Task         @relation(fields: [taskId], references: [id])
  outcome   TaskOutcome?
  note      String?      // "where I left off", shown next session
  @@id([sessionId, taskId])
}

// Time actually spent on each task within a session
model SessionSegment {
  id        String    @id @default(cuid())
  sessionId String
  taskId    String
  session   Session   @relation(fields: [sessionId], references: [id])
  task      Task      @relation(fields: [taskId], references: [id])
  startedAt DateTime
  endedAt   DateTime?
}

// One row per connected account; several per provider allowed
model Integration {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id])
  provider        Provider
  accountEmail    String    // which account, e.g. personal vs school
  label           String?   // display name, e.g. "School"
  accessTokenEnc  String
  refreshTokenEnc String?
  scopes          String
  lastSyncedAt    DateTime?
  @@unique([userId, provider, accountEmail])
}

enum TaskStatus  { TODO IN_PROGRESS DONE DROPPED }
enum TaskSource  { DUMP GITHUB GMAIL OUTLOOK MANUAL }
enum TaskOutcome { DONE PARTIAL NOT_STARTED }
enum Provider    { GOOGLE GITHUB MICROSOFT }
```

A `DailyPlan` table (date + ordered task blocks with scheduled times) comes in with the planning step.

## Build order

The MVP is the full daily loop (capture, plan, work, review) and nothing more. v2 adds context: more accounts and more sources, for a fuller picture of where time goes.

### MVP

- [ ] Auth: Google sign-in + email allowlist
- [ ] Tasks CRUD (with `deferCount` incremented on rollover)
- [ ] Multi-task Pomodoro with segment logging and "where I left off" notes
- [ ] Brain-dump → LLM → tasks
- [ ] Google Calendar read + "plan my day" time-blocking
- [ ] Simple end-of-day summary

### v2 — integrations

- [ ] Provider adapter layer (common calendar and mail interfaces) + multiple accounts per provider
- [ ] Gmail actionable-email detection, across all connected accounts
- [ ] GitHub suggested tasks
- [ ] Microsoft 365 calendar and Outlook mail via Microsoft Graph
- [ ] Combined time-allocation view across every connected calendar

## Open questions and ideas

### Open questions

- Will my school Microsoft 365 tenant allow third-party apps to read mail and calendar, or does it require admin consent? Check by signing in to Microsoft Graph Explorer with the school account before building v2.

### Decisions

- **Name:** Mise, from *mise en place*, the chef's habit of getting everything in its place before cooking starts. Repo: `mise-planner`, since `mise` alone collides with the dev tool.
- **Hook:** "Everything in its place before your day begins." Dump what's on your mind, Mise preps the day, and you just cook.
- **Hosting:** free — Vercel Hobby for the React frontend and the Express API (as Vercel Functions), Neon free Postgres
- **Platform:** web only for now
- **Repo:** public on GitHub, with secrets only in environment variables, a committed `.env.example`, and GitHub push protection on

### Later ideas

- Project allocation: set intended time split per project, compare against actual weekly
- Focus heatmap: completed focus minutes by hour and weekday
- Estimate correction: learn how far off my estimates run per project or tag
- Energy curve: schedule deep work into the hours I actually finish it
- Deferral prompt: at 3+ deferrals, ask to break down, schedule, or drop
- Auto-breakdown of vague tasks into Pomodoro-sized subtasks
- Overflow handling: say what gets bumped when the day is overfull
- Backward planning from deadlines
- Two-way calendar sync: shift blocks when a session runs long
- Auto-complete tasks when a linked PR merges
- Capture from anywhere: hotkey, iOS Shortcut, MCP server
- Focus mode with end-of-session notifications
- Learn which Pomodoro length I actually complete

### Parking lot

- (new ideas go here)
