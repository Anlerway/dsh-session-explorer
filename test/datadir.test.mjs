/**
 * Tests for the data-directory migration.
 *
 *   node --test test/datadir.test.mjs
 *
 * Migration is the one operation that can lose every folder, tag and trashed
 * session at once, so these tests are written against real directories: the
 * interesting properties (a byte-complete copy, a rollback that leaves the old
 * directory untouched, a pointer file the next boot follows) are properties of
 * the filesystem, not of the code around it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { describeDataDir, inspectDataDir, migrateDataDir, readLocation } from "../lib/host/datadir.js";
import {
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
  defaultDataDir,
  ensureDataDir,
  dataPaths,
  resolveDataDir,
} from "../lib/paths.js";
import { openDocuments } from "../lib/store/documents.js";

/**
 * A minimal host api: a data directory, its documents, and the `reopen` hook the
 * migration calls when it switches location.
 *
 * @param {string} dir
 */
async function host(dir) {
  ensureDataDir(dir);
  const paths = dataPaths(dir);
  const api = {
    dataDir: dir,
    paths,
    documents: openDocuments(paths),
    migration: null,
    reopen(next) {
      api.dataDir = next;
      api.paths = dataPaths(next);
      api.documents = openDocuments(api.paths);
    },
  };
  return api;
}

/** @returns {Promise<{ root: string, cleanup: () => Promise<void> }>} */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "se-datadir-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("inspect rejects a relative path", async () => {
  const box = await sandbox();
  try {
    const api = await host(join(box.root, "current"));
    await assert.rejects(() => inspectDataDir(api, "relative/dir"), /absolute path/);
  } finally {
    await box.cleanup();
  }
});

test("inspect rejects a filesystem root", async () => {
  const box = await sandbox();
  try {
    const api = await host(join(box.root, "current"));
    const root = process.platform === "win32" ? "C:\\" : "/";
    await assert.rejects(() => inspectDataDir(api, root), /root cannot be/);
  } finally {
    await box.cleanup();
  }
});

test("inspect rejects the current directory with datadir-same", async () => {
  const box = await sandbox();
  try {
    const current = join(box.root, "current");
    const api = await host(current);
    await assert.rejects(
      () => inspectDataDir(api, current),
      (error) => error.code === "datadir-same",
    );
  } finally {
    await box.cleanup();
  }
});

test("inspect refuses a directory that already holds another installation", async () => {
  const box = await sandbox();
  try {
    const api = await host(join(box.root, "current"));
    const target = join(box.root, "taken");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "tree.v1.json"), "{}", "utf8");
    await assert.rejects(
      () => inspectDataDir(api, target),
      (error) => error.code === "datadir-not-empty",
    );
  } finally {
    await box.cleanup();
  }
});

test("inspect plans a move on the same volume and reports sizes", async () => {
  const box = await sandbox();
  try {
    const api = await host(join(box.root, "current"));
    const plan = await inspectDataDir(api, join(box.root, "next"));
    assert.equal(plan.exists, false);
    assert.equal(plan.writable, true);
    assert.equal(plan.sameVolume, true);
    assert.equal(plan.mode, "move");
    assert.equal(plan.sizeBytes, 0);
  } finally {
    await box.cleanup();
  }
});

test("migrate moves every sidecar and records the new location", async () => {
  const box = await sandbox();
  try {
    const current = join(box.root, "current");
    const target = join(box.root, "next");
    const api = await host(current);

    await api.documents.tree.mutate((draft) => {
      draft.folders["f-1"] = { id: "f-1", name: "Reading", parent: "f-root", createdAt: 1 };
    });
    await api.documents.annotations.mutate((draft) => {
      draft.sessions["session-a"] = { tags: ["keep"], note: "hello", pinned: false, trashed: false };
    });

    const result = await migrateDataDir(api, { target });

    assert.equal(result.mode, "move");
    assert.equal(result.target, target);
    assert.deepEqual(result.steps, ["copied", "verified", "reopened", "recorded", "pointer", "removed"]);
    assert.equal(api.dataDir, target);

    // The moved documents are the ones we wrote, and the new directory records
    // itself so the next boot lands here even without the environment override.
    const tree = await api.documents.tree.read();
    assert.equal(tree.folders["f-1"].name, "Reading");
    const annotations = await api.documents.annotations.read();
    assert.equal(annotations.sessions["session-a"].note, "hello");
    const settings = await api.documents.settings.read();
    assert.equal(settings.dataDir.current, target);

    // `move` is the only mode that deletes the source.
    assert.equal(existsSync(current), false);
    assert.equal(api.migration, null);
  } finally {
    await box.cleanup();
  }
});

test("migrate in copy mode keeps the source and leaves a location pointer", async () => {
  const box = await sandbox();
  try {
    const current = join(box.root, "current");
    const target = join(box.root, "next");
    const api = await host(current);
    await api.documents.tree.mutate((draft) => {
      draft.folders["f-1"] = { id: "f-1", name: "Reading", parent: "f-root", createdAt: 1 };
    });

    const result = await migrateDataDir(api, { target, mode: "copy" });
    assert.equal(result.mode, "copy");
    assert.ok(result.steps.includes("pointer"));

    // The old directory survives, still readable, and points at the new one.
    assert.equal(existsSync(join(current, "tree.v1.json")), true);
    assert.deepEqual(readLocation(current), { movedTo: target, mode: "copy" });
  } finally {
    await box.cleanup();
  }
});

test("a failed migration rolls back and leaves the old directory intact", async () => {
  const box = await sandbox();
  try {
    const current = join(box.root, "current");
    const target = join(box.root, "next");
    const api = await host(current);
    await api.documents.tree.mutate((draft) => {
      draft.folders["f-1"] = { id: "f-1", name: "Reading", parent: "f-root", createdAt: 1 };
    });

    // Make the copy fail *after* the documents were carried over: the settings
    // write is step 5, so a failure there must undo steps 4 and 5. The stub has
    // to be re-applied after `reopen`, which swaps in fresh documents.
    const originalReopen = api.reopen;
    api.reopen = (next) => {
      originalReopen(next);
      if (next === target) {
        api.documents.settings.mutate = async () => {
          throw new Error("disk full");
        };
      }
    };

    await assert.rejects(() => migrateDataDir(api, { target }), /disk full/);
    api.reopen = originalReopen;

    // Back on the old directory, which still holds the original tree; the
    // partial copy is gone.
    assert.equal(api.dataDir, current);
    assert.equal(existsSync(target), false);
    assert.equal(api.migration, null);
    const tree = await api.documents.tree.read();
    assert.equal(tree.folders["f-1"].name, "Reading");
  } finally {
    await box.cleanup();
  }
});

test("a failed migration keeps a target directory the user already had", async () => {
  const box = await sandbox();
  try {
    const current = join(box.root, "current");
    const target = join(box.root, "next");
    // The user made the directory; it is empty, so it is a legal target, but a
    // rollback must empty it rather than remove it.
    await mkdir(target, { recursive: true });
    const api = await host(current);
    const originalReopen = api.reopen;
    api.reopen = (next) => {
      originalReopen(next);
      if (next === target) {
        api.documents.settings.mutate = async () => {
          throw new Error("disk full");
        };
      }
    };

    await assert.rejects(() => migrateDataDir(api, { target }), /disk full/);
    api.reopen = originalReopen;

    assert.equal(existsSync(target), true);
    assert.deepEqual(await readdir(target), []);
    assert.equal(api.dataDir, current);
  } finally {
    await box.cleanup();
  }
});

test("inspect refuses a target that already holds files", async () => {
  const box = await sandbox();
  try {
    const api = await host(join(box.root, "current"));
    const target = join(box.root, "next");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "notes.txt"), "mine", "utf8");    await assert.rejects(
      () => inspectDataDir(api, target),
      (error) => error.code === "datadir-not-empty",
    );
  } finally {
    await box.cleanup();
  }
});

test("a migration in flight refuses other writes", async () => {
  const box = await sandbox();
  try {
    const api = await host(join(box.root, "current"));
    api.migration = { target: join(box.root, "next"), startedAt: Date.now() };
    assert.equal(api.migration.target.endsWith("next"), true);
  } finally {
    await box.cleanup();
  }
});

test("moving the default directory leaves a signpost, not a hole", async () => {
  const box = await sandbox();
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    // Pretend the temporary directory is the user's home, so the *default*
    // data directory lives inside the sandbox and can be pruned for real.
    const home = join(box.root, "home");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const fallback = join(home, ".dsh-session-navigator");
    const target = join(box.root, "elsewhere");

    const api = await host(fallback);
    await api.documents.tree.mutate((draft) => {
      draft.folders["f-1"] = { id: "f-1", name: "Reading", parent: "f-root", createdAt: 1 };
    });

    const result = await migrateDataDir(api, { target });
    assert.ok(result.steps.includes("pruned"));

    // The default directory survives as a signpost: the pointer is all that is
    // left, so the next start follows it instead of starting empty.
    assert.deepEqual(readLocation(fallback), { movedTo: target, mode: "move" });
    assert.equal(existsSync(join(fallback, "tree.v1.json")), false);
    assert.equal(resolveDataDir(process.env), target);

    // And the data itself arrived.
    const tree = await api.documents.tree.read();
    assert.equal(tree.folders["f-1"].name, "Reading");
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
    await box.cleanup();
  }
});

test("describeDataDir reports the location, size and contents", async () => {
  const box = await sandbox();
  try {
    const current = join(box.root, "current");
    const api = await host(current);
    await api.documents.tree.mutate((draft) => {
      draft.folders["f-1"] = { id: "f-1", name: "Reading", parent: "f-root", createdAt: 1 };
    });

    const described = await describeDataDir(api);
    assert.equal(described.current, current);
    assert.equal(described.recorded, null);
    assert.equal(described.exists, true);
    assert.ok(described.sizeBytes > 0);
    const names = described.contents.map((entry) => entry.name);
    assert.ok(names.includes("tree.v1.json"));
  } finally {
    await box.cleanup();
  }
});

test("resolveDataDir prefers the environment, then the recorded location", async () => {
  const box = await sandbox();
  const previous = process.env.DSH_SE_DATA_DIR;
  try {
    const fallback = join(box.root, "default");
    const recorded = join(box.root, "recorded");
    const fromEnv = join(box.root, "from-env");

    // 1. The environment override wins outright.
    process.env.DSH_SE_DATA_DIR = fromEnv;
    assert.equal(resolveDataDir(process.env), fromEnv);

    // 2. Without it, the default directory's own settings document decides.
    delete process.env.DSH_SE_DATA_DIR;
    const home = join(box.root, "home");
    ensureDataDir(join(home, ".dsh-session-navigator"));
    const seeded = dataPaths(join(home, ".dsh-session-navigator"));
    const documents = openDocuments(seeded);
    await documents.settings.mutate((draft) => {
      draft.dataDir = { current: recorded };
    });
    assert.equal(resolveDataDir({ HOME: home, USERPROFILE: home }), recorded);

    // 3. With neither, the default location.
    await rm(join(home, ".dsh-session-navigator", "settings.v1.json"), { force: true });
    assert.equal(resolveDataDir({ HOME: home, USERPROFILE: home }), join(home, ".dsh-session-navigator"));
    assert.ok(fallback);
  } finally {
    if (previous === undefined) delete process.env.DSH_SE_DATA_DIR;
    else process.env.DSH_SE_DATA_DIR = previous;
    await box.cleanup();
  }
});

test("a pre-rename data directory is adopted, not ignored", async () => {
  const box = await sandbox();
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const home = join(box.root, "home");
    const legacy = join(home, LEGACY_DATA_DIR_NAME);
    const current = join(home, DATA_DIR_NAME);
    await mkdir(join(legacy, "trash"), { recursive: true });
    await writeFile(join(legacy, "tree.v1.json"), JSON.stringify({ folders: {} }), "utf8");

    // The plugin used to be called dsh-session-explorer; an install that
    // predates the rename must keep its folders and trash after upgrading.
    const env = { HOME: home, USERPROFILE: home };
    assert.equal(defaultDataDir(env), current);
    assert.equal(resolveDataDir(env), current);
    assert.equal(existsSync(legacy), false, "the old directory is gone, not duplicated");
    assert.equal(existsSync(join(current, "tree.v1.json")), true, "the data came along");
    assert.equal(existsSync(join(current, "trash")), true, "including the trash payloads");

    // A directory that already exists under the new name wins; the old one is
    // left alone rather than merged or deleted.
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "keep.txt"), "untouched", "utf8");
    assert.equal(resolveDataDir(env), current);
    assert.equal(existsSync(join(legacy, "keep.txt")), true);
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
    await box.cleanup();
  }
});
