# apps/db

Database workspace: the Prisma schema (`prisma/schema.prisma`), migrations, and
the shared `PrismaClient` singleton that `apps/api` imports. Keeping it outside
the API package means schema changes and migrations are their own concern.

Run migrations from this directory: `npx prisma migrate dev` (deploy:
`npx prisma migrate deploy`). Client code is scaffolded in milestone M1 (see
`docs/plan.md`).
