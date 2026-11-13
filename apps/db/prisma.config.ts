// Prisma CLI configuration. Its one job: tell the schema engine that
// `user_sessions` is managed outside this schema. The express-session store
// table is owned by connect-pg-simple (see apps/api/src/auth/session.ts) and is
// intentionally absent from schema.prisma — without this declaration, migrate
// would read the table created by `create_user_sessions` as drift and offer to
// drop it.
import { existsSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "prisma/config";

// A config file turns off the CLI's own `.env` loading ("Prisma config
// detected, skipping environment variable loading"), so the local file has to
// be read here or `DATABASE_URL`/`DIRECT_URL` go missing for migrate. Absent in
// CI and on Vercel, where the platform supplies the real values — hence the
// existence check rather than a throw.
const envPath = path.join(import.meta.dirname, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  // `tables.external` is gated behind this flag in Prisma 6.19.
  experimental: { externalTables: true },
  tables: { external: ["public.user_sessions"] },
});
