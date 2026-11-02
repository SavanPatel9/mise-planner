# Mise — project context

Mise ("everything in its place before your day begins") is a single-user task
manager: a morning brain-dump is parsed by Claude into structured tasks, planned
against Google Calendar into a time-blocked day, worked through in multi-task
Pomodoro sessions, and reviewed in an end-of-day summary.

## Stack & layout

TypeScript end-to-end. React + Vite + Tailwind frontend; Express API; Postgres
(Neon) + Prisma; Claude API (structured output) for brain-dump parsing; Google
OAuth via Passport with Postgres-backed cookie sessions. Hosted on Vercel Hobby
(web static, API as Functions) + Neon free tier.

```
apps/web/            Vite + React + Tailwind (components in src/)
apps/api/            Express API (routes/services in src/)
apps/db/             Prisma: schema.prisma, migrations, shared PrismaClient singleton
packages/shared/     types shared web <-> api (API contracts, parsed-task shape)
docs/spec.md         source of truth for scope, data model, auth design
docs/plan.md         milestone/task plan — the work queue
docs/mise-spec-export.md  original export, history only; spec.md supersedes it
```

## Commands

Run from the repo root unless noted. Placeholders until the tooling milestone
lands — update this table as each becomes real.

- Install: `npm install`
- Dev (both apps): `npm run dev` _(placeholder — wired in M1)_
- Test: `npm test` _(placeholder — wired in M1)_
- Lint: `npm run lint` _(placeholder — wired in M1)_
- Migrate: `npx prisma migrate dev` in `apps/db` (deploy: `npx prisma migrate deploy`)

## Conventions

- Schema changes only via Prisma migrations — never edit the database by hand,
  never `db push` against a migrations history.
- **Every query scoped by `userId`.** No exceptions, even though there's one user.
- Secrets only in env vars (`.env`, never committed; `.env.example` lists them).
- **Never log tokens, decrypted secrets, or email content.** OAuth tokens are
  AES-GCM-encrypted at rest; encryption/decryption stays in one module.
- Prisma conventions: `createdAt`/`updatedAt` on every model, every FK indexed,
  explicit `onDelete`, transactions in the service layer only.
- Small diffs that do one thing; match existing file style.

## Dev loop

1. Pick the next unchecked task in `docs/plan.md` (respect depends-on).
2. **implementer** builds it.
3. **test-writer** adds/updates tests.
4. Tests must pass — on failure, dispatch **debugger**, then re-run.
5. **code-reviewer** checks the diff against the task's acceptance criteria.
6. **pr-describer** writes the commit/PR text.
7. Tick the task's checkbox and update its status in plan.md.

## Token rules for agents

- Read the current task, this file, and only the files the task needs — never
  crawl the whole repo.
- Return short summaries to the main session: what changed, what passed/failed,
  open questions. No file dumps.

## Human checkpoints

- Savan approves each milestone's task list before any work on it starts.
- Tasks flagged **[review: line-by-line]** in plan.md (auth, sessions, token
  encryption) get a human line-by-line review before merge.
- Savan reviews before every merge; agents never commit or push.
