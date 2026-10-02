// EdChat API for Turso. Worker variables needed: TURSO_URL and TURSO_TOKEN (set the token as a secret).
// First run: open https://YOUR-WORKER-URL/api/setup once to create the tables.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
const slug = s => String(s || "").toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
const parse = s => { try { return JSON.parse(s) || {}; } catch { return {}; } };
const arg = a => typeof a === "number" ? { type: "integer", value: String(a) } : { type: "text", value: String(a) };

// Runs one or more [sql, args] statements in a single call to Turso.
async function run(env, list) {
  const base = env.TURSO_URL.replace(/^libsql:\/\//, "https://");
  const res = await fetch(base + "/v2/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.TURSO_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        ...list.map(([q, a = []]) => ({ type: "execute", stmt: { sql: q, args: a.map(arg) } })),
        { type: "close" },
      ],
    }),
  });
  const data = await res.json();
  const out = (data.results || []).slice(0, list.length);
  const bad = out.find(r => r.type !== "ok");
  if (!res.ok || bad || out.length < list.length) {
    throw new Error((bad && bad.error && bad.error.message) || "Database error");
  }
  return out.map(r => {
    const { cols, rows, last_insert_rowid, affected_row_count } = r.response.result;
    return {
      rows: rows.map(row => Object.fromEntries(row.map((c, i) =>
        [cols[i].name, c.type === "integer" ? Number(c.value) : c.value]))),
      id: Number(last_insert_rowid),
      changes: affected_row_count,
    };
  });
}
const sql = async (env, q, a) => (await run(env, [[q, a]]))[0];

const SETUP = [
  "CREATE TABLE IF NOT EXISTS ed_rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ed_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL REFERENCES ed_rooms(id), user TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4f5bd5', text TEXT NOT NULL, react TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_ed_messages_room ON ed_messages(room_id, id)",
  "INSERT OR IGNORE INTO ed_rooms (name, created_at) VALUES ('general', strftime('%s','now') * 1000), ('homework', strftime('%s','now') * 1000), ('random', strftime('%s','now') * 1000)",
  "INSERT INTO ed_messages (room_id, user, color, text, created_at) SELECT id, 'EdBot', '#161c33', 'Welcome to EdChat! Type /help to see what I can do.', strftime('%s','now') * 1000 FROM ed_rooms WHERE name = 'general' AND NOT EXISTS (SELECT 1 FROM ed_messages)",
];

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/api/setup") {
        try { await run(env, SETUP.map(s => [s])); return json({ ok: true, message: "Tables created." }); }
        catch (e) { return json({ ok: false, error: e.message }, 500); }
      }

      if (path === "/api/rooms" && req.method === "GET") {
        const { rows } = await sql(env,
          "SELECT name, (SELECT COUNT(*) FROM ed_messages m WHERE m.room_id = ed_rooms.id) AS n FROM ed_rooms ORDER BY id");
        return json(rows);
      }

      if (path === "/api/rooms" && req.method === "POST") {
        const name = slug((await req.json()).name);
        if (!name) return json({ error: "Use letters or numbers in the room name." }, 400);
        await sql(env, "INSERT OR IGNORE INTO ed_rooms (name, created_at) VALUES (?, ?)", [name, Date.now()]);
        return json({ name }, 201);
      }

      if (path === "/api/messages" && req.method === "GET") {
        const { rows } = await sql(env,
          `SELECT * FROM (
             SELECT m.id, m.user, m.color, m.text, m.react, m.created_at AS t
             FROM ed_messages m JOIN ed_rooms r ON r.id = m.room_id
             WHERE r.name = ? ORDER BY m.id DESC LIMIT 100
           ) ORDER BY id`, [slug(url.searchParams.get("room"))]);
        return json(rows.map(m => ({ ...m, react: parse(m.react) })));
      }

      if (path === "/api/messages" && req.method === "POST") {
        const b = await req.json();
        const user = String(b.user || "").trim().slice(0, 20);
        const text = String(b.text || "").trim().slice(0, 2000);
        const color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : "#4f5bd5";
        if (!user || !text) return json({ error: "Name and message are required." }, 400);
        const r = await sql(env,
          "INSERT INTO ed_messages (room_id, user, color, text, created_at) SELECT id, ?, ?, ?, ? FROM ed_rooms WHERE name = ?",
          [user, color, text, Date.now(), slug(b.room)]);
        if (!r.changes) return json({ error: "That room does not exist." }, 404);
        return json({ id: r.id }, 201);
      }

      if (path === "/api/react" && req.method === "POST") {
        const b = await req.json();
        const id = parseInt(b.id, 10);
        const emoji = String(b.emoji || "").slice(0, 8);
        const user = String(b.user || "").trim().slice(0, 20);
        if (!id || !emoji || !user) return json({ error: "Missing details." }, 400);
        const { rows } = await sql(env, "SELECT react FROM ed_messages WHERE id = ?", [id]);
        if (!rows.length) return json({ error: "Message not found." }, 404);
        const react = parse(rows[0].react);
        const list = react[emoji] || [];
        const i = list.indexOf(user);
        i < 0 ? list.push(user) : list.splice(i, 1);
        if (list.length) react[emoji] = list; else delete react[emoji];
        await sql(env, "UPDATE ed_messages SET react = ? WHERE id = ?", [JSON.stringify(react), id]);
        return json({ ok: true });
      }

      if (path === "/api/delete" && req.method === "POST") {
        const b = await req.json();
        const id = parseInt(b.id, 10);
        const user = String(b.user || "").trim().slice(0, 20);
        if (!id || !user) return json({ error: "Missing details." }, 400);
        await sql(env, "DELETE FROM ed_messages WHERE id = ? AND user = ?", [id, user]);
        return json({ ok: true });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Server error. Try again." }, 500);
    }
  },
};
