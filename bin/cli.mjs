#!/usr/bin/env node
// pi-session-index — CLI
//
//   pi-session-index                      scan, then print stats + recent sessions
//   pi-session-index --list --limit 20    newest sessions
//   pi-session-index --list --project ~/code/foo
//   pi-session-index --list --search 分页
//   pi-session-index --projects           one row per project
//   pi-session-index --rebuild            wipe and rebuild (safe: JSONL is the truth)
//   pi-session-index --full               also read whole files (message counts)
//   pi-session-index --watch              rescan on an interval
//
//   --agent-dir <path>   pi agent dir (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
//   --db <path>          database file   (default: <agentDir>/pi-session-index.sqlite)
//   --json               machine-readable output

import { SessionIndex } from "../src/index.mjs";

const argv = process.argv.slice(2);
const flags = { list: false, projects: false, stats: false, rebuild: false, full: false, json: false, watch: null, limit: 10 };
const opts = {};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  switch (a) {
    case "--list": flags.list = true; break;
    case "--projects": flags.projects = true; break;
    case "--stats": flags.stats = true; break;
    case "--rebuild": flags.rebuild = true; break;
    case "--full": flags.full = true; break;
    case "--json": flags.json = true; break;
    case "--limit": flags.limit = Number(next()); break;
    case "--search": opts.search = next(); break;
    case "--project": opts.cwd = next(); break;
    case "--agent-dir": opts.agentDir = next(); break;
    case "--db": opts.dbFile = next(); break;
    case "--watch": flags.watch = Number(next()) || 5; break;
    case "-h":
    case "--help":
      console.log(HELP);
      process.exit(0);
      break;
    default:
      console.error(`unknown argument: ${a}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

const HELP = `pi-session-index — SQLite index over pi's JSONL sessions

  pi-session-index                     scan + brief stats
  pi-session-index --list [--limit N]  newest sessions
         [--project <cwd>] [--search <text>]
  pi-session-index --projects          sessions grouped by project
  pi-session-index --rebuild           drop the index and rebuild
  pi-session-index --full              also read whole files (slower, exact counts)
  pi-session-index --watch [seconds]   rescan periodically
  --agent-dir <path>  --db <path>  --json  --help`;

const human = (ms) => {
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
};
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const short = (p) => String(p).replace(process.env.HOME || "", "~");

async function run() {
  const idx = new SessionIndex(opts);
  if (flags.rebuild) {
    idx.open();
    idx.db.exec("DELETE FROM sessions; DELETE FROM meta");
  }

  const scan = await idx.scan({ full: flags.full });

  if (flags.json) {
    const out = { scan, stats: idx.stats() };
    if (flags.list) out.sessions = idx.list({ ...opts, limit: flags.limit });
    if (flags.projects) out.projects = idx.projects();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (flags.list) {
    const rows = idx.list({ ...opts, limit: flags.limit });
    if (!rows.length) {
      console.log("no sessions matched");
      return;
    }
    for (const s of rows) {
      const title = s.name || s.firstMessage || "(untitled)";
      console.log(`${human(s.updated).padStart(4)}  ${clip(short(s.cwd), 34).padEnd(34)}  ${clip(title, 60)}`);
    }
    console.log(`\n${rows.length} shown · ${scan.total} indexed · ${scan.ms}ms`);
    return;
  }

  if (flags.projects) {
    const rows = idx.projects();
    for (const p of rows) console.log(`${String(p.count).padStart(4)}  ${human(p.latest).padStart(4)}  ${short(p.cwd)}`);
    console.log(`\n${rows.length} projects`);
    return;
  }

  const st = idx.stats();
  console.log(`indexed ${st.total} sessions across ${st.projects} projects in ${scan.ms}ms`);
  console.log(`  added ${scan.added} · updated ${scan.updated} · unchanged ${scan.skipped} · removed ${scan.removed}`);
  console.log(`  db  ${short(st.dbFile)} (${Math.round(st.dbBytes / 1024)}KB)${flags.full ? "" : "  · fast mode: message counts not computed (use --full)"}`);

  const recent = idx.list({ limit: Math.min(flags.limit, 5) });
  if (recent.length) {
    console.log("\nrecent:");
    for (const s of recent) {
      console.log(`  ${human(s.updated).padStart(4)}  ${clip(short(s.cwd), 30).padEnd(30)}  ${clip(s.name || s.firstMessage, 52)}`);
    }
  }
}

await run();

if (flags.watch) {
  const seconds = flags.watch;
  console.log(`\nwatching every ${seconds}s — ctrl-c to stop`);
  setInterval(async () => {
    try {
      const idx = new SessionIndex(opts);
      const r = await idx.scan({ full: flags.full });
      idx.close();
      if (r.added || r.updated || r.removed) {
        console.log(`${new Date().toISOString().slice(11, 19)}  +${r.added} ~${r.updated} -${r.removed}  (${r.ms}ms)`);
      }
    } catch (e) {
      console.error("scan failed:", e?.message ?? e);
    }
  }, seconds * 1000);
}
