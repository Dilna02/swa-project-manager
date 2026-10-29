"use strict";
// Express app for both Vercel (api/[...path].js) and local/Render (server.js).
const path = require("path"), fs = require("fs"), crypto = require("crypto");
const express = require("express"), bcrypt = require("bcryptjs"), { Pool } = require("pg");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const LOCAL_UP = path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "uploads");
const BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;   // set automatically when a Vercel Blob store is connected
const SEED = (() => { try { return require("../seed.json"); } catch (e) { return null; } })();

if (!process.env.DATABASE_URL) console.warn("DATABASE_URL is not set. The app cannot store data until it is.");
let connectionString = process.env.DATABASE_URL;
if (connectionString) {
  const databaseUrl = new URL(connectionString);
  const sslMode = databaseUrl.searchParams.get("sslmode");
  if (["prefer", "require", "verify-ca"].includes((sslMode || "").toLowerCase())) {
    databaseUrl.searchParams.set("sslmode", "verify-full");
    connectionString = databaseUrl.toString();
  }
}
const pool = new Pool({
  connectionString,
  max: 3,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: true }
});

const rid = n => crypto.randomBytes(n).toString("hex");
const q = (t, p) => pool.query(t, p);

// ---------- schema and first-run setup ----------
let ready = null;
function init() {
  if (!ready) ready = (async () => {
    await q(`
      CREATE TABLE IF NOT EXISTS docs(coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(coll, id));
      CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY, name text NOT NULL, role text NOT NULL, hash text,
        legacy_salt text, legacy_hash text, no_login boolean NOT NULL DEFAULT false, created text);
      CREATE TABLE IF NOT EXISTS sessions(token text PRIMARY KEY, uid text NOT NULL, created bigint NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(key text PRIMARY KEY, n int NOT NULL, t bigint NOT NULL);`);
    const n = (await q("SELECT COUNT(*)::int AS n FROM users")).rows[0].n;
    if (!n) await seed();
    await q("DELETE FROM sessions WHERE created < $1", [Date.now() - 30 * 864e5]);
  })().catch(e => { ready = null; throw e; });
  return ready;
}
async function seed() {
  if (SEED) {
    for (const u of SEED.users || [])
      await q("INSERT INTO users(id,name,role,legacy_salt,legacy_hash,no_login,created) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING",
        [u.id, u.name, u.role, u.salt || null, u.hash || null, !!u.noLogin, u.createdOn || ""]);
    for (const c of ["projects", "updates", "tasks"])
      for (const d of SEED[c] || []) { const { id, ...rest } = d; await put(c, id, rest); }
    console.log("Imported seed.json");
  } else {
    const au = (process.env.ADMIN_USER || "admin").toLowerCase(), ap = process.env.ADMIN_PASSWORD || "admin1234";
    if (!process.env.ADMIN_PASSWORD) console.warn("ADMIN_PASSWORD is not set; using the default. Set it before going live.");
    await q("INSERT INTO users(id,name,role,hash,created) VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
      [au, "Admin", "admin", await bcrypt.hash(ap, 10), new Date().toISOString().slice(0, 10)]);
    console.log(`Created admin "${au}".`);
  }
}

// ---------- data helpers ----------
async function getAll(c) { return (await q("SELECT id, data FROM docs WHERE coll=$1", [c])).rows; }
async function getOne(c, id) { const r = (await q("SELECT data FROM docs WHERE coll=$1 AND id=$2", [c, id])).rows[0]; return r ? r.data : null; }
async function put(c, id, d) {
  await q("INSERT INTO docs(coll,id,data) VALUES($1,$2,$3) ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data", [c, id, JSON.stringify(d)]);
}
async function del(c, id) { await q("DELETE FROM docs WHERE coll=$1 AND id=$2", [c, id]); }

// ---------- login rate limit (stored in the database so it works across instances) ----------
async function blocked(key) {
  const a = (await q("SELECT n, t FROM attempts WHERE key=$1", [key])).rows[0];
  return !!a && a.n >= 8 && Date.now() - Number(a.t) < 15 * 60e3;
}
async function noteFail(key) {
  const now = Date.now();
  await q(`INSERT INTO attempts(key,n,t) VALUES($1,1,$2)
    ON CONFLICT (key) DO UPDATE SET n = CASE WHEN attempts.t < $3 THEN 1 ELSE attempts.n + 1 END, t = $2`,
    [key, now, now - 15 * 60e3]);
}

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
  next();
});
app.use(express.json({ limit: "200kb" }));

// wraps async handlers so errors become JSON responses
const H = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => {
  if (e && e.status) return res.status(e.status).json({ error: e.msg });
  console.error(e);
  res.status(500).json({ error: "Server error. Check the server log and DATABASE_URL." });
});

app.use("/api", H(async (req, res, next) => { await init(); next(); }));

async function sessionUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{48})/.exec(req.headers.cookie || "");
  if (!m) return null;
  const r = (await q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=$1 AND s.created>$2",
    [m[1], Date.now() - 30 * 864e5])).rows[0];
  if (r) req.token = m[1];
  return r || null;
}
const needAuth = H(async (req, res, next) => {
  const u = await sessionUser(req);
  if (!u) return res.status(401).json({ error: "Not signed in" });
  req.user = u; next();
});
const needAdmin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "Admin only" });
const pub = u => ({ id: u.id, name: u.name, role: u.role });

async function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
async function verify(u, pw) {
  if (u.no_login) return false;
  if (u.hash) return bcrypt.compare(pw, u.hash);
  if (u.legacy_hash) {   // account imported from the earlier prototype: check once, then upgrade to bcrypt
    const h = await sha((u.legacy_salt || "") + pw);
    const ok = h.length === u.legacy_hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.legacy_hash));
    if (ok) await q("UPDATE users SET hash=$1, legacy_hash=NULL, legacy_salt=NULL WHERE id=$2", [await bcrypt.hash(pw, 10), u.id]);
    return ok;
  }
  return false;
}

// ---------- auth ----------
app.post("/api/login", H(async (req, res) => {
  const username = String((req.body || {}).username || "").trim().toLowerCase(), pw = String((req.body || {}).password || "");
  const key = req.ip + "|" + username;
  if (await blocked(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const u = (await q("SELECT * FROM users WHERE id=$1", [username])).rows[0];
  if (!u || !(await verify(u, pw))) { await noteFail(key); return res.status(401).json({ error: "Wrong username or password." }); }
  await q("DELETE FROM attempts WHERE key=$1", [key]);
  const token = rid(24);
  await q("INSERT INTO sessions(token,uid,created) VALUES($1,$2,$3)", [token, u.id, Date.now()]);
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 30 * 864e5, path: "/" });
  res.json(pub(u));
}));
app.post("/api/logout", H(async (req, res) => {
  if (await sessionUser(req)) await q("DELETE FROM sessions WHERE token=$1", [req.token]);
  res.clearCookie("sid", { path: "/" }); res.json({ ok: true });
}));
app.get("/api/me", needAuth, (req, res) => res.json(pub(req.user)));
app.post("/api/password", needAuth, H(async (req, res) => {
  const pw = String((req.body || {}).password || "");
  if (pw.length < 4) return res.status(400).json({ error: "Use at least 4 characters." });
  await q("UPDATE users SET hash=$1, legacy_hash=NULL, legacy_salt=NULL, no_login=false WHERE id=$2", [await bcrypt.hash(pw, 10), req.user.id]);
  res.json({ ok: true });
}));

// ---------- developer accounts (admin) ----------
app.post("/api/users", needAuth, needAdmin, H(async (req, res) => {
  const b = req.body || {}, name = String(b.name || "").trim(), pw = String(b.password || "");
  let id = String(b.username || "").trim().toLowerCase();
  if (!name) return res.status(400).json({ error: "Enter the developer’s name." });
  if (!id) id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!/^[a-z0-9._@-]{1,80}$/.test(id)) return res.status(400).json({ error: "Username can use letters, numbers and . _ @ - only." });
  if ((await q("SELECT 1 FROM users WHERE id=$1", [id])).rows[0]) return res.status(409).json({ error: "That username already exists." });
  if (pw && pw.length < 4) return res.status(400).json({ error: "Use at least 4 characters for the password." });
  await q("INSERT INTO users(id,name,role,hash,no_login,created) VALUES($1,$2,$3,$4,$5,$6)",
    [id, name, "developer", pw ? await bcrypt.hash(pw, 10) : null, !pw, new Date().toISOString().slice(0, 10)]);
  res.json({ id, login: !!pw });
}));
app.post("/api/users/:id/password", needAuth, needAdmin, H(async (req, res) => {
  const pw = String((req.body || {}).password || "");
  const u = (await q("SELECT * FROM users WHERE id=$1", [req.params.id])).rows[0];
  if (!u || u.role !== "developer") return res.status(404).json({ error: "Developer not found" });
  if (pw.length < 4) return res.status(400).json({ error: "Use at least 4 characters." });
  await q("UPDATE users SET hash=$1, legacy_hash=NULL, legacy_salt=NULL, no_login=false WHERE id=$2", [await bcrypt.hash(pw, 10), u.id]);
  await q("DELETE FROM sessions WHERE uid=$1", [u.id]);
  res.json({ ok: true });
}));
app.delete("/api/users/:id", needAuth, needAdmin, H(async (req, res) => {
  const u = (await q("SELECT * FROM users WHERE id=$1", [req.params.id])).rows[0];
  if (!u || u.role !== "developer") return res.status(404).json({ error: "Developer not found" });
  await q("DELETE FROM sessions WHERE uid=$1", [u.id]);
  await q("DELETE FROM users WHERE id=$1", [u.id]);
  res.json({ ok: true });
}));

// ---------- data collections ----------
const COLL = ["projects", "updates", "tasks", "users", "meetings"];
const MEET_FIELDS = ["projectId", "date", "mom"];
const TASK_DEV_FIELDS = ["status", "doneOn", "priority", "note", "pendingReason", "due", "updatedTs"];
const ADMIN_TASK_FIELDS = ["title", "projectId", "assignee", "status", "doneOn", "priority", "note", "pendingReason", "due", "updatedTs", "images"];
const UPD_FIELDS = ["projectId", "date", "ts", "task", "status", "dev", "qa", "blocker", "reason", "next", "nextDate", "finalDate", "remark"];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
const isObj = o => o && typeof o === "object" && !Array.isArray(o);

app.get("/api/c/:coll", needAuth, H(async (req, res) => {
  const c = req.params.coll, me = req.user, admin = me.role === "admin";
  if (!COLL.includes(c)) return res.status(404).json({ error: "Unknown collection" });
  if (c === "users") {
    const rows = (await q("SELECT id,name,role,no_login,created FROM users" + (admin ? "" : " WHERE id=$1"), admin ? [] : [me.id])).rows;
    return res.json(rows.map(u => ({ id: u.id, data: { name: u.name, role: u.role, noLogin: !!u.no_login, createdOn: u.created } })));
  }
  let rows = await getAll(c);
if (!admin && c === "meetings") {
  const mine = new Set((await getAll("projects")).filter(p => p.data.assignee === me.id).map(p => p.id));
  rows = rows.filter(r => mine.has(r.data.projectId));
} else if (!admin) {
  rows = rows.filter(r => c === "projects" ? r.data.assignee === me.id : c === "updates" ? r.data.userId === me.id : r.data.assignee === me.id);
}  if (c === "updates") rows.sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)) || (b.data.ts || 0) - (a.data.ts || 0));
  res.json(rows);
}));

// Returns the document to store, or throws {status,msg}.
async function authorise(me, c, op, id, body) {
  const admin = me.role === "admin", fail = (s, m) => { throw { status: s, msg: m }; };
  if (!COLL.includes(c) || c === "users") fail(404, "Unknown collection");
  if (op !== "delete" && !isObj(body)) fail(400, "Bad data");
  const ex = op === "add" ? null : await getOne(c, id);
  if (c === "projects") { if (!admin) fail(403, "Admin only"); return op === "update" ? { ...(ex || {}), ...body } : body; }
  if (c === "meetings") {
  if (admin) {
    if (op === "delete") return null;
    return op === "add"
      ? { ...pick(body, MEET_FIELDS), createdBy: me.id, createdTs: Date.now() }
      : { ...(ex || {}), ...pick(body, MEET_FIELDS) };
  }
  if (op === "add") {
    const proj = await getOne("projects", body.projectId);
    if (!proj || proj.assignee !== me.id) fail(403, "That project is not assigned to you");
    return { ...pick(body, MEET_FIELDS), createdBy: me.id, createdTs: Date.now() };
  }
  if (!ex || ex.createdBy !== me.id) fail(403, "Not your meeting");
  return op === "delete" ? null : { ...ex, ...pick(body, MEET_FIELDS) };
}
  if (c === "updates") {
    if (admin) return op === "update" ? { ...(ex || {}), ...body } : body;
    if (op === "delete") fail(403, "Not allowed");
    const d = pick(body, UPD_FIELDS), proj = await getOne("projects", d.projectId);
    if (!proj || proj.assignee !== me.id) fail(403, "That project is not assigned to you");
    if (ex && ex.userId !== me.id) fail(403, "Not your update");
    if (id !== d.projectId + "_" + d.date) fail(400, "Bad update id");
    return { ...d, userId: me.id, ts: Date.now() };
  }
  if (c === "tasks") {
    if (admin) {
      if (op === "add") return { ...body, createdBy: me.id, createdByRole: "admin" };
      if (op === "delete") return null;
      return op === "update" ? { ...(ex || {}), ...pick(body, ADMIN_TASK_FIELDS) } : body;
    }
    if (op === "add") {
      const proj = await getOne("projects", body.projectId);
      if (!proj || proj.assignee !== me.id) fail(403, "That project is not assigned to you");
      return { ...body, assignee: me.id, createdBy: me.id, createdByRole: "developer" };
    }
    if (!ex || ex.assignee !== me.id) fail(403, "Not your task");
    if (op === "delete") { if (ex.createdByRole !== "developer") fail(403, "Only the admin can delete this task"); return null; }
    const allowed = ex.createdByRole === "developer" ? [...TASK_DEV_FIELDS, "title"] : TASK_DEV_FIELDS;
    return { ...ex, ...pick(body, allowed) };
  }
}
async function run(req, res, op) {
  const c = req.params.coll, id = op === "add" ? rid(10) : req.params.id;
  try {
    const doc = await authorise(req.user, c, op, id, req.body);
    if (op === "delete") await del(c, id);
    else await put(c, id, doc);
    res.json({ id });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.msg });
    console.error(e); res.status(500).json({ error: "Server error" });
  }
}
app.post("/api/c/:coll", needAuth, H((req, res) => run(req, res, "add")));
app.put("/api/c/:coll/:id", needAuth, H((req, res) => run(req, res, "set")));
app.patch("/api/c/:coll/:id", needAuth, H((req, res) => run(req, res, "update")));
app.delete("/api/c/:coll/:id", needAuth, H((req, res) => run(req, res, "delete")));

// ---------- images ----------
// On Vercel the image goes to Vercel Blob and the page stores its public URL.
// Without a Blob store (local testing) the file is kept in DATA_DIR and served by /api/blob/:id.
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
app.post("/api/upload", needAuth, express.raw({ type: Object.keys(EXT), limit: "10mb" }), H(async (req, res) => {
  const type = (req.headers["content-type"] || "").split(";")[0], ext = EXT[type];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Only PNG, JPG, GIF or WEBP images." });
  if (BLOB) {
    const { put: blobPut } = require("@vercel/blob");
    const r = await blobPut(`swa-tasks/${rid(12)}.${ext}`, req.body, { access: "public", contentType: type, addRandomSuffix: true });
    return res.json({ id: r.url });
  }
  const id = rid(12) + "." + ext;
  fs.mkdirSync(LOCAL_UP, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_UP, id), req.body);
  res.json({ id });
}));
app.get("/api/blob/:id", needAuth, (req, res) => {
  if (!/^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(req.params.id)) return res.status(404).end();
  const f = path.join(LOCAL_UP, req.params.id);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=86400").sendFile(f);
});

const PROJECT_FILE_TYPES = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".feature": "text/plain",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip"
};
app.post("/api/project-files/upload", needAuth, needAdmin, express.raw({ type: "*/*", limit: "10mb" }), H(async (req, res) => {
  const rawName = String(req.headers["x-file-name"] || "");
  let name;
  try { name = decodeURIComponent(rawName); }
  catch (_) { return res.status(400).json({ error: "Invalid file name." }); }
  name = path.basename(name.replace(/\\/g, "/")).slice(0, 180);
  const ext = path.extname(name).toLowerCase(), type = PROJECT_FILE_TYPES[ext];
  if (!type || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: "Upload a non-empty PDF, Word, Excel, CSV, TXT, JSON, FEATURE or ZIP file." });
  }
  if (BLOB) {
    const { put: blobPut } = require("@vercel/blob");
    const r = await blobPut(`swa-project-files/${rid(12)}${ext}`, req.body, { access: "public", contentType: type, addRandomSuffix: true });
    return res.json({ file: { id: r.url, name, type, size: req.body.length } });
  }
  const id = rid(12) + ext;
  fs.mkdirSync(LOCAL_UP, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_UP, id), req.body);
  res.json({ file: { id, name, type, size: req.body.length } });
}));
app.get("/api/project-files/:id", needAuth, H(async (req, res) => {
  if (!/^[a-f0-9]{24}\.(csv|doc|docx|feature|json|pdf|txt|xls|xlsx|zip)$/.test(req.params.id)) return res.status(404).end();
  const projects = await getAll("projects");
  const file = projects
    .filter(p => req.user.role === "admin" || p.data.assignee === req.user.id)
    .flatMap(p => Array.isArray(p.data.testCases) ? p.data.testCases : [])
    .find(f => f && f.id === req.params.id);
  if (!file) return res.status(404).end();
  const fullPath = path.join(LOCAL_UP, req.params.id);
  if (!fs.existsSync(fullPath)) return res.status(404).end();
  const filename = String(file.name || "test-case" + path.extname(req.params.id)).replace(/[\r\n"]/g, "_");
  res.set({
    "Cache-Control": "private, max-age=86400",
    "Content-Type": PROJECT_FILE_TYPES[path.extname(req.params.id).toLowerCase()],
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  }).sendFile(fullPath);
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use(express.static(PUBLIC, { index: "index.html" }));   // Vercel serves public/ directly; this is for local runs
module.exports = app;
