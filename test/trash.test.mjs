/**
 * Tests for the trash.
 *
 *   node --test test/trash.test.mjs
 *
 * Deleting a session is a real directory move, so the properties worth testing
 * are filesystem properties: the payload really left DSH's sessions tree, it
 * really came back to the right project directory, and an interrupted move
 * leaves something reconcilable rather than a lost conversation.
 *
 * The fake api is deliberately thin — a home, a data directory and a stubbed
 * reader — because everything interesting happens in the filesystem.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import {
  emptyTrash,
  purgeSessions,
  reconcileTrash,
  restoreSessions,
  trashSessions,
} from "../lib/host/trash.js";
import { ensureDataDir, dataPaths } from "../lib/paths.js";
import { trashTargetDir } from "../lib/domain/trash.js";
import { openDocuments } from "../lib/store/documents.js";
import { createShortcut } from "../lib/domain/shortcuts.js";
import { FIXED_NODES } from "../lib/constants.js";

/** A deterministic id source, so a test can name the row it is looking for. */
function idFactory(seed) {
  let n = 0;
  return () => `${seed}${++n}`;
}

const LOG = "session.v4.jsonl.zstd";

/**
 * Write a session log whose first frame is a valid header.
 *
 * @param {string} home
 * @param {string} project
 * @param {string} sessionId
 * @param {{ cwd?: string, workspaceId?: string }} [extra]
 * @returns {Promise<string>} the session directory
 */
async function writeSession(home, project, sessionId, extra = {}) {
  const dir = join(home, "sessions", project, sessionId);
  await mkdir(dir, { recursive: true });
  const header = {
    type: "session",
    version: 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd: extra.cwd ?? "C:\\work",
  };
  await writeFile(join(dir, LOG), zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n")));
  return dir;
}

/**
 * @param {{ home: string, dataDir: string, sessions?: object[] }} input
 */
function fakeApi({ home, dataDir, sessions = [] }) {
  ensureDataDir(dataDir);
  const paths = dataPaths(dataDir);
  return {
    dshHome: () => home,
    paths,
    documents: openDocuments(paths),
    invalidated: 0,
    reader: {
      async snapshot() {
        return { view: { sessions } };
      },
      invalidate() {
        this.invalidated += 1;
      },
    },
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "se-trash-"));
  return {
    root,
    home: join(root, "home"),
    dataDir: join(root, "data"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("trashing moves the session directory into the bin", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({
      home: box.home,
      dataDir: box.dataDir,
      sessions: [{ id: "s1", title: "first", workspaceId: "w1", workspaceTitle: "proj" }],
    });
    const dir = await writeSession(box.home, "proj", "s1");

    const result = await trashSessions(api, ["s1"]);
    assert.deepEqual(result.trashed, ["s1"]);
    assert.equal(existsSync(dir), false, "payload must leave the sessions tree");

    const index = await api.documents.trash.read();
    const entry = index.entries.s1;
    assert.equal(entry.title, "first", "the title is snapshotted");
    assert.equal(entry.workspaceId, "w1");
    assert.equal(entry.originalLogPath, join(dir, LOG));
    assert.equal(entry.pending, undefined, "a finished move is not pending");
    assert.equal(existsSync(join(box.dataDir, "trash", entry.trashId, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("trashing skips unknown ids instead of failing the batch", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir });
    await writeSession(box.home, "proj", "s1");
    const result = await trashSessions(api, ["s1", "nope"]);
    assert.deepEqual(result.trashed, ["s1"]);
    assert.deepEqual(result.skipped, ["nope"]);
  } finally {
    await box.cleanup();
  }
});

test("a running session is refused without cancelling the rest of the batch", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({
      home: box.home,
      dataDir: box.dataDir,
      sessions: [
        { id: "s1", title: "live", running: true },
        { id: "s2", title: "idle" },
      ],
    });
    const live = await writeSession(box.home, "proj", "s1");
    const idle = await writeSession(box.home, "proj", "s2");

    const result = await trashSessions(api, ["s1", "s2"]);
    assert.deepEqual(result.trashed, ["s2"], "the idle session still goes");
    assert.deepEqual(result.skipped, ["s1"]);
    assert.deepEqual(
      result.errors.map((error) => [error.sessionId, error.code]),
      [["s1", "session-active"]],
      "the refusal is reported per id instead of throwing away the batch",
    );
    assert.equal(existsSync(live), true, "the running session keeps its log");
    assert.equal(existsSync(idle), false);
    const index = await api.documents.trash.read();
    assert.deepEqual(Object.keys(index.entries), ["s2"], "a refusal leaves no entry behind");
  } finally {
    await box.cleanup();
  }
});

test("two windows trashing the same session leave one entry and one payload", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({
      home: box.home,
      dataDir: box.dataDir,
      sessions: [{ id: "s1", title: "once" }],
    });
    const dir = await writeSession(box.home, "proj", "s1");

    const [first, second] = await Promise.all([trashSessions(api, ["s1"]), trashSessions(api, ["s1"])]);
    const winners = [first, second].filter((result) => result.trashed.length === 1);
    assert.equal(winners.length, 1, "exactly one of the two moves the payload");
    const loser = [first, second].find((result) => result.trashed.length === 0);
    assert.deepEqual(loser.skipped, ["s1"], "the loser reports the id as skipped, not as an error");

    const index = await api.documents.trash.read();
    const entry = index.entries.s1;
    assert.ok(entry, "the entry the winner wrote survives the loser's compensation");
    assert.equal(existsSync(join(box.dataDir, "trash", entry.trashId, LOG)), true, "the payload is reachable");
    assert.equal(existsSync(dir), false);
  } finally {
    await box.cleanup();
  }
});

test("restore puts the session back where it came from", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({
      home: box.home,
      dataDir: box.dataDir,
      sessions: [{ id: "s1", title: "first", workspaceId: "w1" }],
    });
    const dir = await writeSession(box.home, "proj", "s1");
    await trashSessions(api, ["s1"]);

    const result = await restoreSessions(api, ["s1"]);
    assert.deepEqual(result.restored, ["s1"]);
    assert.equal(existsSync(join(dir, LOG)), true);
    const index = await api.documents.trash.read();
    assert.deepEqual(Object.keys(index.entries), []);
  } finally {
    await box.cleanup();
  }
});

test("restore falls back to a project directory of the same workspace", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({
      home: box.home,
      dataDir: box.dataDir,
      sessions: [{ id: "s1", title: "first", workspaceId: "w1" }],
    });
    const original = await writeSession(box.home, "gone", "s1");
    await trashSessions(api, ["s1"]);

    // The recorded project directory disappears while the session sits in the
    // bin, but another workspace project still exists.
    await rm(dirname(original), { recursive: true, force: true });
    const survivor = await writeSession(box.home, "alive", "s2");

    const result = await restoreSessions(api, ["s1"]);
    assert.deepEqual(result.restored, ["s1"]);
    const landed = join(dirname(survivor), "s1", LOG);
    assert.equal(existsSync(landed), true);
  } finally {
    await box.cleanup();
  }
});

test("restore recreates the recorded directory when nothing is left", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }] });
    const original = await writeSession(box.home, "gone", "s1");
    await trashSessions(api, ["s1"]);
    await rm(join(box.home, "sessions"), { recursive: true, force: true });

    const result = await restoreSessions(api, ["s1"]);
    assert.deepEqual(result.restored, ["s1"]);
    assert.equal(existsSync(join(original, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("restore refuses to overwrite a directory that reappeared", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }] });
    const dir = await writeSession(box.home, "proj", "s1");
    await trashSessions(api, ["s1"]);
    await mkdir(dir, { recursive: true });

    // Refused per entry, not by throwing the whole batch: the payload stays in
    // the bin and the caller is told why.
    const result = await restoreSessions(api, ["s1"]);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.skipped, ["s1"]);
    assert.equal(result.errors[0].code, "target-exists");
    const index = await api.documents.trash.read();
    assert.equal(index.entries.s1.pending, undefined, "the entry survives a refusal");
  } finally {
    await box.cleanup();
  }
});

test("restore drops a stale entry whose payload is gone", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }] });
    await writeSession(box.home, "proj", "s1");
    await trashSessions(api, ["s1"]);
    const index = await api.documents.trash.read();
    await rm(join(box.dataDir, "trash", index.entries.s1.trashId), { recursive: true, force: true });

    const result = await restoreSessions(api, ["s1"]);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.skipped, ["s1"]);
    assert.deepEqual(Object.keys((await api.documents.trash.read()).entries), []);
  } finally {
    await box.cleanup();
  }
});

test("purge deletes the payload and the entry", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }] });
    await writeSession(box.home, "proj", "s1");
    await trashSessions(api, ["s1"]);
    const index = await api.documents.trash.read();
    const payload = join(box.dataDir, "trash", index.entries.s1.trashId);

    const result = await purgeSessions(api, ["s1"]);
    assert.deepEqual(result.purged, ["s1"]);
    assert.equal(existsSync(payload), false);
    assert.deepEqual(Object.keys((await api.documents.trash.read()).entries), []);
  } finally {
    await box.cleanup();
  }
});

/**
 * The one way a shortcut may disappear: its target does.
 *
 * A reference is not the user's to delete — the row is a second sighting of
 * something that lives elsewhere — so removing the payload has to take every
 * pointing row with it. Trashing is *not* that moment: a binned session can
 * still come back, and a reference that vanishes on 删除 but returns on 还原
 * would be worse than one that never moved.
 */
test("purging a session prunes the references that pointed at it", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }, { id: "s2" }] });
    await writeSession(box.home, "proj", "s1");
    await writeSession(box.home, "proj", "s2");
    await api.documents.tree.mutate((draft) => {
      createShortcut(draft, { kind: "session", targetId: "s1", parent: FIXED_NODES.favorites }, idFactory("a"));
      createShortcut(draft, { kind: "session", targetId: "s2", parent: FIXED_NODES.todos }, idFactory("b"));
    });

    await trashSessions(api, ["s1"]);
    assert.equal(
      Object.keys((await api.documents.tree.read()).shortcuts ?? {}).length,
      2,
      "trashing keeps both references: the session is recoverable",
    );

    await purgeSessions(api, ["s1"]);
    const kept = Object.values((await api.documents.tree.read()).shortcuts ?? {});
    assert.equal(kept.length, 1, "only the reference to the purged session is gone");
    assert.equal(kept[0].targetId, "s2", "the surviving reference still points at s2");
  } finally {
    await box.cleanup();
  }
});

test("emptyTrash purges every entry", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({
      home: box.home,
      dataDir: box.dataDir,
      sessions: [{ id: "s1" }, { id: "s2" }],
    });
    await writeSession(box.home, "proj", "s1");
    await writeSession(box.home, "proj", "s2");
    await trashSessions(api, ["s1", "s2"]);

    const result = await emptyTrash(api);
    assert.equal(result.purged.length, 2);
    assert.deepEqual(Object.keys((await api.documents.trash.read()).entries), []);
    assert.deepEqual(await readdir(join(box.dataDir, "trash")), ["index.v1.json"]);
  } finally {
    await box.cleanup();
  }
});

test("reconcile promotes a pending entry whose payload arrived", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }] });
    await writeSession(box.home, "proj", "s1");
    await trashSessions(api, ["s1"]);
    const index = await api.documents.trash.read();
    const trashId = index.entries.s1.trashId;
    await api.documents.trash.mutate((draft) => {
      draft.entries.s1.pending = true;
    });

    const result = await reconcileTrash(api);
    assert.deepEqual(result.promoted, ["s1"]);
    assert.deepEqual(result.dropped, []);
    assert.equal((await api.documents.trash.read()).entries.s1.pending, undefined);
    assert.equal(existsSync(join(box.dataDir, "trash", trashId, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("reconcile drops a pending entry whose payload never moved", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }] });
    const dir = await writeSession(box.home, "proj", "s1");
    await api.documents.trash.mutate((draft) => {
      draft.entries.s1 = {
        sessionId: "s1",
        trashId: "t-crashed-1",
        title: "first",
        originalLogPath: join(dir, LOG),
        deletedAt: 1,
        pending: true,
      };
    });

    const result = await reconcileTrash(api);
    assert.deepEqual(result.dropped, ["s1"]);
    assert.deepEqual(Object.keys((await api.documents.trash.read()).entries), []);
  } finally {
    await box.cleanup();
  }
});

test("a payload directory name cannot escape the trash directory", () => {
  const paths = { trashDir: join(tmpdir(), "se-trash-root", "trash") };
  // The id is read back from plain JSON on disk, so a hand edit must not be able
  // to aim `rm -rf` at anything but a payload directly under `trash/`.
  for (const bad of ["../../Documents", "..", "t-abc/../../x", "", "t-ABC-1", "t-abc-1/../../.."]) {
    assert.throws(() => trashTargetDir(paths, bad), (error) => error.code === "trash-not-found", bad);
  }
  assert.equal(trashTargetDir(paths, "t-lz9x1a-abc123"), join(paths.trashDir, "t-lz9x1a-abc123"));
});
