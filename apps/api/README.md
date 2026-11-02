# apps/api

Express API, exported as an app and wrapped for Vercel Functions. Database
access goes through the `apps/db` workspace (Prisma schema, migrations, and
client live there). App code is scaffolded in milestone M1 (see
`docs/plan.md`); nothing in `src/` yet by design.
