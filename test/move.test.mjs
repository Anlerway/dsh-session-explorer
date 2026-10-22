/**
 * Tests for cross-workspace move / copy (P5).
 *
 *   node --test test/move.test.mjs
 *
 * The interesting properties are filesystem and accounting properties:
 *
 *   - the artifact leaves the source project directory and lands in the target
 *     workspace's directory under DSH's own encoding;
 *   - its header cwd is rewritten, its events are byte-identical;
 *   - the registry accounting is swapped, and a failure during the swap puts
 *     both the bytes and the header index back.
 *
 * Path encoding is pinned against the directory names observed on a real DSH
 * home (see 交接文档.md §5.4), because getting it wrong writes a session to a
 * directory DSH will never look in.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import {
  encodeSegment,
  projectKey,
  readArtifact,
  inheritedCutOf,
  isContiguousLog,
} from "../lib/sources/artifact.js";
import { moveSessions } from "../lib/host/move.js";

const LOG = "session.v4.jsonl.zstd";

/**
 * Write a session log with a real header frame and one event frame.
 *
 * @param {string} home
 * @param {string} project
 * @param {string} sessionId
 * @param {{ cwd?: string, events?: object[], origin?: string }} [extra]
 * @returns {Promise<{ dir: string, log: string }>}
 */
async function writeSession(home, project, sessionId, extra = {}) {
  const dir = join(home, "sessions", project, sessionId);
  await mkdir(dir, { recursive: true });
  const header = {
    type: "session",
    version: 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd: extra.cwd ?? "C:\\work\\source",
    ...(extra.origin ? { origin: extra.origin } : {}),
  };
  const events = extra.events ?? [
    { seq: 0, type: "turn/start", time: 1, data: { turn: 1 } },
    { seq: 1, type: "turn/end", time: 2, data: { turn: 1 } },
  ];
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n"));
  const bodyFrame = zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n"));
  const log = join(dir, LOG);
  await writeFile(log, Buffer.concat([headerFrame, bodyFrame]));
  return { dir, log };
}

/**
 * A registry with the two methods the move path actually uses.
 *
 * @param {Array<{ id: string, title: string, path: string, sessionIds: string[] }>} workspaces
 */
function fakeRegistry(workspaces) {
  const entities = workspaces.map((record) => ({
    id: record.id,
    title: record.title,
    path: record.path,
    record,
    async attachSession(sessionId) {
      if (!record.sessionIds.includes(sessionId)) record.sessionIds.unshift(sessionId);
    },
    async detachSession(sessionId) {
      record.sessionIds = record.sessionIds.filter((id) => id !== sessionId);
    },
  }));
  return {
    entities,
    headers: new Map(),
    failAttach: false,
    list: () => entities,
    async indexHeader(header) {
      this.headers.set(header.id, header);
    },
    async enqueueOperation(operation) {
      return operation();
    },
    find(id) {
      return entities.find((entity) => entity.id === id);
    },
  };
}

function fakeApi(home) {
  return {
    ctx: {
      get: (name) => (name === "workspaceRegistry" ? this.registry : undefined),
      sessions: { get: () => undefined },
    },
    dshHome: () => home,
    reader: { invalidated: 0, invalidate() { this.invalidated += 1; } },
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "se-move-"));
  const home = join(root, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  return { root, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * An api whose ctx resolves a specific registry.
 *
 * @param {string} home
 * @param {any} registry
 */
function apiWith(home, registry) {
  return {
    ctx: { get: (name) => (name === "workspaceRegistry" ? registry : undefined) },
    dshHome: () => home,
    reader: { invalidated: 0, invalidate() { this.invalidated += 1; } },
  };
}

// ── path encoding ───────────────────────────────────────────────────────────

test("projectKey reproduces DSH's directory names", () => {
  assert.equal(projectKey("C:\\Users\\alice\\Desktop\\session-explorer"), "--C-Users-alice-Desktop-session-explorer--");
  assert.equal(projectKey("C:\\Users\\alice\\.dsh\\dsh_orb"), "--C-Users-alice-.dsh-dsh_orb--");
  // The observed escaped names: spaces become ~0020, parentheses ~0028/~0029.
  assert.equal(
    projectKey("C:\\Users\\alice\\Downloads\\新建文件夹 (2)"),
    "--C-Users-alice-Downloads-~65B0~5EFA~6587~4EF6~5939~0020~00282~0029--",
  );
  assert.equal(projectKey("C:\\Users\\alice\\Downloads\\新建文件夹"), "--C-Users-alice-Downloads-~65B0~5EFA~6587~4EF6~5939--");
});

test("encodeSegment escapes exactly what DSH escapes", () => {
  assert.equal(encodeSegment("session-c312bb10-0f03-4d1c-a6f3-140f7725d4ab"), "session-c312bb10-0f03-4d1c-a6f3-140f7725d4ab");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("a~b"), "a~007Eb");
  assert.equal(encodeSegment("a:b"), "a~003Ab");
});

// ── artifact I/O ────────────────────────────────────────────────────────────

test("readArtifact decodes every frame and keeps event order", async () => {
  const box = await sandbox();
  try {
    const { log } = await writeSession(box.home, "proj", "s1");
    const artifact = await readArtifact(log);
    assert.equal(artifact.header.id, "s1");
    assert.equal(artifact.events.length, 2);
    assert.deepEqual(artifact.events.map((event) => event.seq), [0, 1]);
  } finally {
    await box.cleanup();
  }
});

test("a log whose tail is still being written exports everything before it", async () => {
  const box = await sandbox();
  try {
    const { log } = await writeSession(box.home, "proj", "s1");
    // A writer halfway through appending an event: the frame is torn, so the
    // file no longer ends with a complete line.
    const torn = zstdCompressSync(Buffer.from(JSON.stringify({ seq: 2, type: "turn/start" })));
    await appendFile(log, torn.subarray(0, 8));

    await assert.rejects(
      () => readArtifact(log),
      (error) => error.code === "session-corrupt",
      "a rewrite must still refuse to guess what the torn frame held",
    );
    const artifact = await readArtifact(log, { tolerateTail: true });
    assert.deepEqual(artifact.events.map((event) => event.seq), [0, 1], "the complete frames are all exported");
  } finally {
    await box.cleanup();
  }
});

test("an export drops the half-written JSON line instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "se-artifact-"));
  try {
    const log = join(dir, "session.v4.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 4, id: "s1", cwd: "C:/work" }),
      JSON.stringify({ seq: 0, type: "turn/start" }),
      '{"seq":1,"type":"tur',
    ];
    await writeFile(log, lines.join("\n"));

    await assert.rejects(() => readArtifact(log), (error) => error.code === "session-corrupt");
    const artifact = await readArtifact(log, { tolerateTail: true });
    assert.deepEqual(artifact.events.map((event) => event.seq), [0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inheritedCutOf finds the final inherited marker", () => {  assert.equal(inheritedCutOf([{ seq: 0 }, { seq: 1, type: "session/end-seed", data: { inherited: true } }]), 2);
  assert.equal(inheritedCutOf([{ seq: 0 }, { seq: 1, type: "session/end-seed", data: {} }]), null);
  assert.equal(isContiguousLog([{ seq: 0 }, { seq: 1 }]), true);
  assert.equal(isContiguousLog([{ seq: 0 }, { seq: 2 }]), false);
});

// ── move ────────────────────────────────────────────────────────────────────

test("moving a session rewrites cwd and swaps the registry accounting", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const { dir, log } = await writeSession(box.home, "proj", "s1");

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true);
    assert.deepEqual(result.results[0].fromWorkspaceIds, ["w-source"]);

    assert.equal(existsSync(dir), false, "the source directory must be gone");
    const movedLog = result.results[0].artifactTo;
    const moved = await readArtifact(movedLog);
    assert.equal(moved.header.cwd, targetPath);
    assert.equal(moved.header.id, "s1");
    assert.equal(moved.header.createdAt, 1_700_000_000_000, "header fields other than cwd are preserved");
    assert.equal(moved.events.length, 2, "the events survive the move");

    assert.deepEqual(registry.find("w-source").record.sessionIds, []);
    assert.deepEqual(registry.find("w-target").record.sessionIds, ["s1"]);
    assert.equal(registry.headers.get("s1").cwd, targetPath);
  } finally {
    await box.cleanup();
  }
});

test("a failed registry attach rolls both the bytes and the accounting back", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const target = registry.find("w-target");
    target.attachSession = async () => {
      throw Object.assign(new Error("registry is read-only right now"), { code: "gateway/internal" });
    };
    const api = apiWith(box.home, registry);
    const { dir } = await writeSession(box.home, "proj", "s1");

    await assert.rejects(
      () => moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } }),
      /read-only/,
    );

    assert.equal(existsSync(join(dir, LOG)), true, "the artifact must be back where it started");
    const restored = await readArtifact(join(dir, LOG));
    assert.equal(restored.header.cwd, "C:\\work\\source", "the original header is restored");
    assert.equal(registry.headers.get("s1").cwd, "C:\\work\\source");
    assert.deepEqual(registry.find("w-source").record.sessionIds, ["s1"]);
  } finally {
    await box.cleanup();
  }
});

test("moving into the workspace that already owns the session is a no-op", async () => {
  const box = await sandbox();
  try {
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
    ]);
    const api = apiWith(box.home, registry);
    const { dir } = await writeSession(box.home, "proj", "s1");

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-source" } });
    assert.equal(result.results[0].moved, false);
    assert.equal(existsSync(join(dir, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("subagent sessions are refused", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    await writeSession(box.home, "proj", "s1", { origin: "subagent" });

    await assert.rejects(
      () => moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } }),
      (error) => error.code === "subagent-unsupported",
    );
  } finally {
    await box.cleanup();
  }
});

test("a live session is refused instead of being moved under its writer", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    api.ctx.sessions = { get: (id) => (id === "s1" ? { id: "s1" } : undefined) };
    await writeSession(box.home, "proj", "s1");

    await assert.rejects(
      () => moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } }),
      (error) => error.code === "session-active",
      "a batch where nothing moved surfaces the failure instead of a 200 of refusals",
    );
  } finally {
    await box.cleanup();
  }
});

test("one refused id does not cancel the ids that could move", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    api.ctx.sessions = { get: (id) => (id === "s1" ? { id: "s1" } : undefined) };
    const live = await writeSession(box.home, "proj", "s1");
    const idle = await writeSession(box.home, "proj", "s2");

    const result = await moveSessions(api, { ids: ["s1", "s2"], target: { workspaceId: "w-target" } });
    assert.equal(result.results.length, 2, "every id gets an entry, in the order it was asked for");
    assert.deepEqual(
      result.results.map((row) => [row.sessionId, row.ok, row.code]),
      [
        ["s1", false, "session-active"],
        ["s2", true, undefined],
      ],
      "the live session is reported, and the idle one still moves",
    );
    assert.equal(existsSync(join(live.dir, LOG)), true, "the refused session keeps its log where it was");
    assert.equal(existsSync(idle.dir), false);
  } finally {
    await box.cleanup();
  }
});

test("an unknown target workspace is refused before anything moves", async () => {
  const box = await sandbox();
  try {
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
    ]);
    const api = apiWith(box.home, registry);
    const { dir } = await writeSession(box.home, "proj", "s1");

    await assert.rejects(
      () => moveSessions(api, { ids: ["s1"], target: { workspaceId: "nope" } }),
      (error) => error.code === "workspace-not-found",
    );
    assert.equal(existsSync(join(dir, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

// ── copy ────────────────────────────────────────────────────────────────────

test("copying writes a second session with a fresh id and the same events", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const { log } = await writeSession(box.home, "proj", "s1");

    const result = await moveSessions(api, { ids: ["s1"], copy: true, target: { workspaceId: "w-target" } });
    const copy = result.results[0];
    assert.equal(copy.copied, true);
    assert.notEqual(copy.sessionId, "s1");

    const original = await readArtifact(log);
    assert.equal(original.header.id, "s1", "the source session is untouched");
    assert.equal(original.header.cwd, "C:\\work\\source");

    const duplicated = await readArtifact(copy.artifactTo);
    assert.equal(duplicated.header.id, copy.sessionId);
    assert.equal(duplicated.header.cwd, targetPath);
    assert.deepEqual(duplicated.events, original.events, "the event stream is copied verbatim");
    assert.deepEqual(registry.find("w-target").record.sessionIds, [copy.sessionId]);
    assert.deepEqual(registry.find("w-source").record.sessionIds, ["s1"]);
  } finally {
    await box.cleanup();
  }
});
