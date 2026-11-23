// pi-session-index — a SQLite index over pi's JSONL session files.
//
// pi writes every session as JSONL under <agentDir>/sessions/<encoded-cwd>/.
// Listing them means reading hundreds of files; a long session can be hundreds
// of megabytes, so a naive scan takes seconds and the sidebar polls. This module
// keeps a disposable SQLite mirror of the metadata next to the sessions.
//
// The JSONL files stay the source of truth: delete the database and it rebuilds.
//
// Two scan modes:
//   fast (default) — reads only the head of each file (header + first user
//                    message). 405 sessions in ~200ms.
//   full           — reads every file to the end for message counts and last
//                    message. Slow, opt-in.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";

const SCHEMA_VERSION = "1";
const HEAD_BYTES = 32 * 1024;

/** Resolve pi's agent directory the same way pi itself does. */
export function resolveAgentDir(agentDir) {
  const env = agentDir ?? process.env.PI_CODING_AGENT_DIR;
  if (!env) return join(homedir(), ".pi", "agent");
  return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text);
  return parts.length ? parts.join(" ") : undefined;
}

/** Read the first `maxBytes` of a session file and pull out what the sidebar needs. */
async function readHead(file, maxBytes = HEAD_BYTES) {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const cut = bytesRead === maxBytes && !text.endsWith("\n");
    const lines = text.split("\n");
    if (cut) lines.pop(); // last line may be truncated

    let header = null;
    let firstMessage;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!header && entry.type === "session") {
        header = entry;
        if (firstMessage) break;
        continue;
      }
      if (firstMessage === undefined && entry.type === "message" && entry.message?.role === "user") {
        firstMessage = textOf(entry.message.content);
        if (header) break;
      }
    }
    return { header, firstMessage, truncated: cut };
  } finally {
    await fh.close();
  }
}

async function scanSessions(agentDir) {
  const root = join(agentDir, "sessions");
  const found = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const dir of projects) {
    if (!dir.isDirectory()) continue;
    const sub = join(root, dir.name);
    let names;
    try {
      names = await readdir(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(sub, name);
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      found.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return found;
}

export class SessionIndex {
  /**
   * @param {object} [options]
   * @param {string} [options.agentDir] pi agent directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent)
   * @param {string} [options.dbFile] database path (default: <agentDir>/pi-session-index.sqlite)
   */
  constructor(options = {}) {
    this.agentDir = resolveAgentDir(options.agentDir);
    this.dbFile = options.dbFile ?? join(this.agentDir, "pi-session-index.sqlite");
    this.db = null;
  }

  open() {
    if (this.db) return this.db;
    mkdirSync(dirname(this.dbFile), { recursive: true });
    const db = new DatabaseSync(this.dbFile);
    db.exec([
      "PRAGMA journal_mode = WAL",
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
      `CREATE TABLE IF NOT EXISTS sessions (
         path TEXT PRIMARY KEY,
         cwd TEXT NOT NULL,
         name TEXT,
         first_message TEXT,
         last_message TEXT,
         message_count INTEGER NOT NULL DEFAULT 0,
         updated INTEGER NOT NULL DEFAULT 0,
         created INTEGER NOT NULL DEFAULT 0,
         bytes_read INTEGER NOT NULL DEFAULT 0,
         mtime_ms INTEGER NOT NULL DEFAULT 0
       )`,
      "CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd, updated DESC)",
    ].join("; "));
    const version = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v;
    if (version !== SCHEMA_VERSION) {
      db.exec("DELETE FROM sessions; DELETE FROM meta");
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    }
    this.db = db;
    return db;
  }

  close() {
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }

  /**
   * Bring the index up to date with the sessions on disk.
   * @param {{ full?: boolean, force?: boolean }} [options]
   *   full  — read whole files (message count + last message); slow
   *   force — re-read every file even when the mtime is unchanged
   */
  async scan(options = {}) {
    const { full = false, force = false } = options;
    const started = Date.now();
    const db = this.open();
    const files = await scanSessions(this.agentDir);

    const known = new Map();
    for (const row of db.prepare("SELECT path, mtime_ms, bytes_read FROM sessions").all()) {
      known.set(row.path, row);
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const upsert = db.prepare(`
      INSERT INTO sessions (path, cwd, name, first_message, last_message, message_count, updated, created, bytes_read, mtime_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        cwd = excluded.cwd, first_message = excluded.first_message,
        last_message = excluded.last_message, message_count = excluded.message_count,
        updated = excluded.updated, created = excluded.created,
        bytes_read = excluded.bytes_read, mtime_ms = excluded.mtime_ms
    `);

    db.exec("BEGIN");
    try {
      const seen = new Set();
      for (const f of files) {
        seen.add(f.file);
        const row = known.get(f.file);
        if (row && !force && row.mtime_ms === Math.round(f.mtimeMs) && !(full && !row.bytes_read)) {
          skipped++;
          continue;
        }
        let head = { header: null, firstMessage: undefined, truncated: false };
        let messageCount = 0;
        let lastMessage;
        try {
          head = await readHead(f.file);
          if (full) {
            // Whole-file pass: count messages and capture the tail of the conversation.
            const fh = await open(f.file, "r");
            try {
              const text = (await fh.readFile()).toString("utf8");
              for (const line of text.split("\n")) {
                if (!line.trim()) continue;
                let entry;
                try {
                  entry = JSON.parse(line);
                } catch {
                  continue;
                }
                if (entry.type !== "message") continue;
                messageCount++;
                const t = textOf(entry.message?.content);
                if (t) lastMessage = t;
              }
            } finally {
              await fh.close();
            }
          }
        } catch {
          continue;
        }
        const cwd = head.header?.cwd ?? "";
        const createdMs = Date.parse(head.header?.timestamp ?? "") || Math.round(f.mtimeMs);
        upsert.run(
          f.file,
          cwd,
          null,
          head.firstMessage ?? null,
          lastMessage ?? null,
          messageCount,
          Math.round(f.mtimeMs),
          createdMs,
          full ? f.size : head.truncated ? HEAD_BYTES : f.size,
          Math.round(f.mtimeMs),
        );
        if (row) updated++;
        else added++;
      }
      // Drop rows whose files are gone.
      let removed = 0;
      for (const path of known.keys()) {
        if (seen.has(path)) continue;
        db.prepare("DELETE FROM sessions WHERE path = ?").run(path);
        removed++;
      }
      db.exec("COMMIT");
      return { total: files.length, added, updated, skipped, removed, ms: Date.now() - started, full };
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  /**
   * @param {{ cwd?: string, search?: string, limit?: number, offset?: number }} [options]
   * @returns {Array<object>} newest first
   */
  list(options = {}) {
    const db = this.open();
    const where = [];
    const params = [];
    if (options.cwd) {
      where.push("cwd = ?");
      params.push(options.cwd);
    }
    if (options.search) {
      where.push("(first_message LIKE ? OR last_message LIKE ? OR cwd LIKE ?)");
      const like = `%${options.search}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT path, cwd, name, first_message, last_message, message_count, updated, created
                 FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY updated DESC
                 LIMIT ? OFFSET ?`;
    params.push(options.limit ?? 50, options.offset ?? 0);
    return db.prepare(sql).all(...params).map((r) => ({
      path: r.path,
      cwd: r.cwd,
      name: r.name ?? undefined,
      firstMessage: r.first_message ?? undefined,
      lastMessage: r.last_message ?? undefined,
      messageCount: r.message_count ?? 0,
      updated: r.updated,
      created: r.created,
    }));
  }

  /** One row per project directory, newest activity first. */
  projects() {
    const db = this.open();
    return db
      .prepare(
        `SELECT cwd, COUNT(*) AS count, MAX(updated) AS latest
         FROM sessions GROUP BY cwd ORDER BY latest DESC`,
      )
      .all()
      .map((r) => ({ cwd: r.cwd, count: r.count, latest: r.latest }));
  }

  stats() {
    const db = this.open();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COUNT(DISTINCT cwd) AS projects,
                MAX(updated) AS newest,
                SUM(message_count) AS messages
         FROM sessions`,
      )
      .get();
    return {
      total: row?.total ?? 0,
      projects: row?.projects ?? 0,
      messages: row?.messages ?? 0,
      newest: row?.newest ?? 0,
      dbFile: this.dbFile,
      dbBytes: (() => {
        try {
          return statSync(this.dbFile).size;
        } catch {
          return 0;
        }
      })(),
    };
  }
}

export default SessionIndex;
