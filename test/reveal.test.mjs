/**
 * Tests for the reveal allowlist (L10).
 *
 * `POST /reveal-path` hands a path to DSH's `openWorkspacePath`, which opens it
 * in Explorer/Finder. The client only ever sends the cwd of a session it is
 * showing, so the plugin only accepts paths it already lists — a session's cwd
 * or a workspace's directory. Without that check the route is a general "open
 * any path" primitive reachable from any page in the app, and a UNC path is a
 * credential leak rather than a convenience.
 *
 *   node --test test/reveal.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";

import { knownDirectory } from "../lib/index.js";
import { nativePath, revealSessionDir, revealSessionFile, sessionLogFile, sessionLogPath } from "../lib/host/actions.js";

/** @param {any} snapshot */
function apiWithSnapshot(snapshot) {
  return { reader: { snapshot: async () => snapshot } };
}

const snapshot = {
  sessions: [{ id: "s1", cwd: join("C:", "work", "alpha") }],
  trashed: [{ id: "s2", cwd: join("C:", "work", "beta") }],
  tree: { nodes: { "w-wa": { type: "workspace", path: join("C:", "work", "gamma") } } },
};

test("a session cwd and a workspace directory may be revealed", async () => {
  const api = apiWithSnapshot(snapshot);
  assert.equal(await knownDirectory(api, join("C:", "work", "alpha")), true);
  assert.equal(await knownDirectory(api, join("C:", "work", "beta")), true);
  assert.equal(await knownDirectory(api, join("C:", "work", "gamma")), true);
});

test("a path the plugin does not list is refused", async () => {
  const api = apiWithSnapshot(snapshot);
  assert.equal(await knownDirectory(api, join("C:", "Windows", "System32")), false);
  assert.equal(await knownDirectory(api, "\\\\host\\share"), false);
  assert.equal(await knownDirectory(api, ""), false);
});

test("a subdirectory of a known path is not the known path", async () => {
  const api = apiWithSnapshot(snapshot);
  assert.equal(await knownDirectory(api, join("C:", "work", "alpha", "src")), false);
});

// ── 跳转至文件位置: one session's own log ────────────────────────────────────
// The client sends an id; the host resolves the path. These cover the two places
// a log can be (where DSH keeps it, and where the trash moved it) plus the case
// where neither knows it.

const trashDir = join("C:", "data", "trash");
const liveLog = join("C:", "data", "sessions", "p-alpha", "session-1", "session.v4.jsonl.zstd");

/** @param {{ sessions?: any[], entries?: Record<string, any> }} [options] */
function apiWithLogs({ sessions = [], entries = {} } = {}) {
  return {
    ctx: { sessionController: { openWorkspacePath: async (request) => opened.push(request) } },
    paths: { trashDir },
    reader: { snapshot: async () => ({ sessions }) },
    documents: { trash: { read: async () => ({ entries }) } },
  };
}

/** @type {any[]} */
const opened = [];

test("the path handed to Windows uses backslashes", () => {
  // explorer.exe and the shell automation interface both ignore `C:/x/y`:
  // the first silently opens Documents, the second finds no window at all.
  assert.equal(nativePath("win32", "C:/Users/mi/.dsh/sessions/x"), String.raw`C:\Users\mi\.dsh\sessions\x`);
  assert.equal(nativePath("win32", String.raw`C:\already\windows`), String.raw`C:\already\windows`);
  // Other platforms take the path exactly as the caller wrote it.
  assert.equal(nativePath("darwin", "/Users/mi/x"), "/Users/mi/x");
  assert.equal(nativePath("linux", "/home/mi/x"), "/home/mi/x");
});

test("a live session's log is the one the snapshot already read", async () => {
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  assert.equal(await sessionLogFile(api, "s1"), liveLog);
});

test("a trashed session's log is under the trash id it moved to", async () => {
  const original = join("C:", "data", "sessions", "p-alpha", "session-2", "session.v4.jsonl.zstd");
  const api = apiWithLogs({
    entries: { s2: { sessionId: "s2", trashId: "t-abc-123", originalLogPath: original } },
  });
  assert.equal(await sessionLogFile(api, "s2"), join(trashDir, "t-abc-123", "session.v4.jsonl.zstd"));
});

test("复制文件路径 resolves the same file without touching the OS", async () => {
  opened.length = 0;
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  const result = await sessionLogPath(api, "s1");
  assert.equal(result.path, liveLog);
  assert.equal(result.name, "session.v4.jsonl.zstd");
  // No opener and no DSH hand-off: copying a path must not open anything.
  assert.equal(opened.length, 0);
});

test("复制文件路径 answers for a trashed session too", async () => {
  const original = join("C:", "data", "sessions", "p-alpha", "session-3", "session.v4.jsonl.zstd");
  const api = apiWithLogs({
    entries: { s3: { sessionId: "s3", trashId: "t-def-456", originalLogPath: original } },
  });
  const result = await sessionLogPath(api, "s3");
  assert.equal(result.path, join(trashDir, "t-def-456", "session.v4.jsonl.zstd"));
  assert.equal(result.name, "session.v4.jsonl.zstd");
});

test("a session with no log anywhere is refused instead of guessed", async () => {
  const api = apiWithLogs({});
  await assert.rejects(() => sessionLogFile(api, "ghost"), /no session log to locate/);
  await assert.rejects(() => sessionLogFile(api, ""), /sessionId is required/);
});

test("跳转至文件位置 selects the file, it does not open its folder", async () => {
  opened.length = 0;
  /** @type {any[]} */
  const calls = [];
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  api.openInFileManager = async (path, select) => {
    calls.push({ path, select });
    return true;
  };
  assert.deepEqual(await revealSessionFile(api, "s1"), {
    path: liveLog,
    opened: true,
    via: "native",
    name: "session.v4.jsonl.zstd",
  });
  // `select: true` is what makes Explorer/Finder highlight the item; without it
  // the user lands in the folder and has to find the file themselves.
  assert.deepEqual(calls, [{ path: liveLog, select: true }]);
  // DSH is not consulted when the OS opener already worked.
  assert.deepEqual(opened, []);
});

test("DSH resolving is not evidence that anything opened", async () => {
  // 现场症状：提示"已打开"，桌面上没有窗口。`session.openWorkspacePath` 在没有桌面
  // 宿主的构建里（Web GUI）会正常 resolve 而不做任何事，所以"成功"这个信号本身
  // 不可信 —— 判据只能是插件自己有没有把进程拉起来。
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  api.openInFileManager = async () => true;
  const result = await revealSessionFile(api, "s1");
  assert.equal(result.via, "native");
  assert.deepEqual(opened, []);
});

test("when the OS has no opener, DSH still gets the hand-off", async () => {
  opened.length = 0;
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  api.openInFileManager = async () => false;
  assert.deepEqual(await revealSessionFile(api, "s1"), {
    path: liveLog,
    opened: true,
    via: "dsh",
    name: "session.v4.jsonl.zstd",
  });
  // `action: 'reveal'` is the select gesture on DSH's side.
  assert.deepEqual(opened, [{ path: liveLog, action: "reveal" }]);
});

test("neither the OS nor DSH can open the path: the error surfaces", async () => {
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  api.openInFileManager = async () => false;
  api.ctx.sessionController.openWorkspacePath = async () => {
    throw new Error("Path has no verified Host path");
  };
  await assert.rejects(() => revealSessionFile(api, "s1"), /no verified Host path/);
});

test("在文件管理器中显示 opens the session's cwd, not its log folder", async () => {
  /** @type {any[]} */
  const calls = [];
  const cwd = join("C:", "work", "alpha");
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog, cwd }] });
  api.openInFileManager = async (path, select) => {
    calls.push({ path, select });
    return true;
  };
  assert.deepEqual(await revealSessionDir(api, "s1"), { path: cwd, opened: true, via: "native" });
  assert.deepEqual(calls, [{ path: cwd, select: false }]);
});

test("a session that never recorded a cwd falls back to its log folder", async () => {
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  api.openInFileManager = async () => true;
  assert.equal((await revealSessionDir(api, "s1")).path, dirname(liveLog));
});

test("the native shell binding is optional, not required", async () => {
  const { forgetNativeBinding, revealNatively } = await import("../lib/host/native-reveal.js");
  // A missing FFI binding must answer `null` (fall back to PowerShell), never
  // throw and never silently claim success.
  forgetNativeBinding();
  assert.equal(revealNatively(join("C:", "work", "alpha")), null);
});

test("a reveal that the shell API refuses falls through to the next opener", async () => {
  const api = apiWithLogs({ sessions: [{ id: "s1", logPath: liveLog }] });
  /** @type {any[]} */
  const calls = [];
  api.openInFileManager = async (path, select) => {
    calls.push({ path, select });
    return { ok: true, via: "shell", detail: "shell" };
  };
  const result = await revealSessionFile(api, "s1");
  assert.equal(result.path, liveLog);
  assert.equal(result.opened, true);
  assert.equal(result.via, "native");
  assert.equal(result.detail, "shell");
  assert.deepEqual(calls, [{ path: liveLog, select: true }]);
});

test("复制文件夹地址 answers the workspace's directory without touching the OS", async () => {
  const { workspaceDirPath } = await import("../lib/host/actions.js");
  const dir = join("C:", "work", "gamma");
  const api = {
    reader: { snapshot: async () => ({ registry: { workspaces: new Map([["w1", { id: "w1", path: dir }]]) } }) },
    openInFileManager: async () => {
      throw new Error("must not open anything");
    },
  };
  assert.deepEqual(await workspaceDirPath(api, "w1"), { path: dir, name: "gamma" });
});

test("a workspace with no recorded directory is refused, not guessed", async () => {
  const { workspaceDirPath } = await import("../lib/host/actions.js");
  const api = { reader: { snapshot: async () => ({ registry: { workspaces: new Map([["w1", { id: "w1" }]]) } }) } };
  await assert.rejects(() => workspaceDirPath(api, "w1"), /没有记录路径/);
  await assert.rejects(() => workspaceDirPath(api, "nope"), /unknown workspace/);
});
