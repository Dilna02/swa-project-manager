// One-time import of your existing data into an empty database.
// Usage (run on your own computer, never commit the seed file):
//   DATABASE_URL="postgres://..." node scripts/import-seed.js ./seed.json
"use strict";
const fs = require("fs");
const { Pool } = require("pg");

const file = process.argv[2];
if (!process.env.DATABASE_URL || !file) {
  console.error('Usage: DATABASE_URL="postgres://..." node scripts/import-seed.js ./seed.json');
  process.exit(1);
}
const seed = JSON.parse(fs.readFileSync(file, "utf8"));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: true } });

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs(coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(coll, id));
    CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY, name text NOT NULL, role text NOT NULL, hash text,
      legacy_salt text, legacy_hash text, no_login boolean NOT NULL DEFAULT false, created text);
    CREATE TABLE IF NOT EXISTS sessions(token text PRIMARY KEY, uid text NOT NULL, created bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts(key text PRIMARY KEY, n int NOT NULL, t bigint NOT NULL);`);
  const n = (await pool.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n;
  if (n) { console.error("The database already has users. Nothing imported, to protect existing data."); process.exit(2); }
  for (const u of seed.users || [])
    await pool.query("INSERT INTO users(id,name,role,legacy_salt,legacy_hash,no_login,created) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [u.id, u.name, u.role, u.salt || null, u.hash || null, !!u.noLogin, u.createdOn || ""]);
  for (const c of ["projects", "updates", "tasks"])
    for (const d of seed[c] || []) {
      const { id, ...rest } = d;
      await pool.query("INSERT INTO docs(coll,id,data) VALUES($1,$2,$3) ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data", [c, id, JSON.stringify(rest)]);
    }
  console.log(`Imported ${seed.users?.length || 0} users, ${seed.projects?.length || 0} projects, ${seed.tasks?.length || 0} tasks, ${seed.updates?.length || 0} updates.`);
  await pool.end();
})().catch(e => { console.error("Import failed:", e.message); process.exit(1); });
