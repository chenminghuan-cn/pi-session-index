#!/usr/bin/env node
// Self-check: builds a throwaway agent dir with fake sessions and exercises the
// whole surface. No framework, no fixtures on disk.
//
//   node test/smoke.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../src/index.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-session-index-test-"));
const sessions = join(root, "sessions");

function encodeCwd(cwd) {
  return "--" + cwd.replace(/^\//, "").replace(/[/:]/g, "-") + "--";
}

function writeSession(cwd, slug, messages, mtimeOffsetSec = 0) {
  const dir = join(sessions, encodeCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}.jsonl`);
  const now = new Date(Date.now() + mtimeOffsetSec * 1000 + 100).toISOString();
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: slug, timestamp: now, cwd }),
    JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: now, provider: "p", modelId: "m" }),
  ];
  for (const [i, [role, text]] of messages.entries()) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `e${i}`,
        parentId: i ? `e${i - 1}` : "m1",
        timestamp: now,
        message: { role, content: [{ type: "text", text }], timestamp: now },
      }),
    );
  }
  writeFileSync(file, lines.join("\n") + "\n");
  if (mtimeOffsetSec) {
    const t = new Date(Date.now() + mtimeOffsetSec * 1000);
    utimesSync(file, t, t);
  }
  return file;
}

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const A = "/tmp/demo/alpha";
const B = "/tmp/demo/beta";

writeSession(A, "a1", [["user", "帮我重构支付模块"], ["assistant", "先看依赖"]], -3600);
writeSession(A, "a2", [["user", "分页怎么做"], ["assistant", "加 limit/offset"]], -60);
writeSession(B, "b1", [["user", "这个 bug 怎么查"], ["assistant", "先加日志"]], -7200);

console.log("\npi-session-index self-check\n");

const idx = new SessionIndex({ agentDir: root });

const first = await idx.scan();
check("first scan finds 3 sessions", () => assert.equal(first.total, 3));
check("first scan adds all", () => assert.equal(first.added, 3));

check("list is newest-first", () => {
  const rows = idx.list();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].firstMessage, "分页怎么做");
  assert.equal(rows[2].firstMessage, "这个 bug 怎么查");
});

check("list filters by cwd", () => {
  const rows = idx.list({ cwd: A });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.cwd === A));
});

check("list searches message text", () => {
  const rows = idx.list({ search: "支付" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firstMessage, "帮我重构支付模块");
});

check("list honours limit/offset", () => {
  const all = idx.list();
  const page = idx.list({ limit: 1, offset: 1 });
  assert.equal(page.length, 1);
  assert.equal(page[0].path, all[1].path);
});

check("projects groups by cwd", () => {
  const rows = idx.projects();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cwd, A); // newest activity first
  assert.equal(rows[0].count, 2);
});

check("stats reports totals", () => {
  const st = idx.stats();
  assert.equal(st.total, 3);
  assert.equal(st.projects, 2);
  assert.ok(st.dbBytes > 0);
});

const second = await idx.scan();
check("rescan is a no-op", () => {
  assert.equal(second.added, 0);
  assert.equal(second.removed, 0);
  assert.equal(second.skipped, 3);
});

writeSession(A, "a3", [["user", "新会话"]], 0);
const third = await idx.scan();
check("picks up a new file", () => {
  assert.equal(third.added, 1);
  assert.equal(third.total, 4);
});

rmSync(join(sessions, encodeCwd(A), "a3.jsonl"));
const fourth = await idx.scan();
check("drops a deleted file", () => {
  assert.equal(fourth.removed, 1);
  assert.equal(idx.list().length, 3);
});

const full = await idx.scan({ full: true, force: true });
check("full scan counts messages", () => {
  assert.ok(full.full);
  const rows = idx.list({ limit: 1 });
  assert.equal(rows[0].messageCount, 2);
});

check("no index file outside the agent dir", () => {
  assert.ok(idx.dbFile.startsWith(root));
});

idx.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${process.exitCode ? "FAILED" : "PASSED"}: ${pass} checks`);
