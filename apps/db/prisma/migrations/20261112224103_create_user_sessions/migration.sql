-- CreateTable: express-session store, owned at runtime by connect-pg-simple
-- (see apps/api/src/auth/session.ts) and deliberately absent from
-- schema.prisma; Prisma ignores it via `tables.external` in prisma.config.ts.
-- Creating it here instead of at runtime means a fresh database is usable
-- before the first request.
--
-- Copied from connect-pg-simple 10.0.0's table.sql, which is what created the
-- table in production, with only two adaptations: the table name (the library
-- string-replaces "session" with the configured name, which is why the
-- constraint and index keep the unreplaced "session" names), and IF NOT EXISTS
-- so this migration is a no-op where the library already created the table.
-- The primary key is inlined because ADD CONSTRAINT has no IF NOT EXISTS; it
-- is identical to the library's `NOT DEFERRABLE INITIALLY IMMEDIATE`, those
-- being the defaults.
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
)
WITH (OIDS=FALSE);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");
