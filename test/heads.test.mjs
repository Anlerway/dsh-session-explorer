/**
 * Tests for the session-header scan.
 *
 *   node --test test/heads.test.mjs
 *
 * Three properties matter here and none of them is visible from the outside:
 * a log written by another format version is still found (the name carries the
 * version, so a hard-coded name hides old sessions silently), two copies of one
 * session id always resolve to the same one (the scan used to push in parallel
 * and take whichever finished first), and a directory without a log is skipped
 * instead of yielding an entry that later reads as "no header".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { discoverLogs, readAllHeaders } from "../lib/sources/heads.js";

/**
 * Write a session log whose first frame is a header line.
 *
 * @param {string} dshHome
 * @param {string} project
 * @param {string} sessionDir
 * @param {{ id: string, version?: number, formatVersion?: number }} header
 */
async function writeSession(dshHome, project, sessionDir, header) {
  const dir = join(dshHome, "sessions", project, sessionDir);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    type: "session",
    version: header.formatVersion ?? 4,
    id: header.id,
    createdAt: 1,
    cwd: "/tmp/x",
  });
  const frame = zstdCompressSync(Buffer.from(`${line}\n`, "utf8"));
  const path = join(dir, `session.v${header.version ?? 4}.jsonl.zstd`);
  await writeFile(path, frame);
  return path;
}

test("a log written by an older format version is still discovered", async () => {
  const home = await mkdtemp(join(tmpdir(), "heads-"));
  try {
    const old = await writeSession(home, "proj", "s-1", { id: "s-1", version: 1 });
    await writeSession(home, "proj", "s-2", { id: "s-2", version: 4 });

    const logs = await discoverLogs(home);
    assert.deepEqual(logs.map((entry) => entry.logPath), [old, join(home, "sessions", "proj", "s-2", "session.v4.jsonl.zstd")]);

    const headers = await readAllHeaders(home);
    assert.deepEqual([...headers.keys()].sort(), ["s-1", "s-2"]);
    // The version in the file name and the version inside the header are two
    // different things; both are reported and neither is assumed.
    assert.equal(headers.get("s-1").formatVersion, 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("two copies of one session id resolve the same way every scan", async () => {
  const home = await mkdtemp(join(tmpdir(), "heads-"));
  try {
    // `a-proj` sorts before `b-proj`, so its copy wins — by path, not by timing.
    const first = await writeSession(home, "a-proj", "s-1", { id: "s-1" });
    await writeSession(home, "b-proj", "s-1", { id: "s-1" });

    for (let round = 0; round < 5; round += 1) {
      const headers = await readAllHeaders(home);
      assert.equal(headers.get("s-1").logPath, first);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a session directory without a log is not an entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "heads-"));
  try {
    await mkdir(join(home, "sessions", "proj", "empty"), { recursive: true });
    await writeSession(home, "proj", "s-1", { id: "s-1" });

    const logs = await discoverLogs(home);
    assert.equal(logs.length, 1);
    assert.deepEqual(await readAllHeaders(home).then((map) => [...map.keys()]), ["s-1"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the scan survives a project directory it cannot read", async () => {
  const home = await mkdtemp(join(tmpdir(), "heads-"));
  try {
    await writeSession(home, "proj", "s-1", { id: "s-1" });
    // A stray file where a project directory is expected: it is skipped, and the
    // real project is still scanned.
    await writeFile(join(home, "sessions", "not-a-dir"), "x");

    const headers = await readAllHeaders(home);
    assert.deepEqual([...headers.keys()], ["s-1"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
