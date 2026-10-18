/**
 * Tests for the sidecar store and the two rule modules that mutate it.
 *
 *   node --test test/store.test.mjs
 *
 * The store is exercised against a real temporary directory (not a mock), because
 * the properties worth pinning down — atomic replace, revision guard, serialized
 * writes, corrupt-file recovery — are properties of the filesystem interaction
 * and would be invisible in a mock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSidecar, writeAtomic } from "../lib/store/sidecar.js";
import { openDocuments } from "../lib/store/documents.js";
import {
  TAG_LIMIT,
  TAG_MAX_LENGTH,
  idsWithFlag,
  normalizeAnnotation,
  normalizeTags,
  patchAnnotation,
  tagIndex,
} from "../lib/domain/annotations.js";
import { createFolder, deleteFolder, moveNode, renameFolder, reorderNode } from "../lib/domain/folders.js";
import { buildAutoTree, canMove } from "../lib/domain/tree.js";
import { FIXED_NODES } from "../lib/constants.js";

/** @returns {Promise<{ dir: string, paths: any, cleanup: () => Promise<void> }>} */
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), "se-store-"));
  const tmp = join(dir, ".tmp");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(tmp, { recursive: true });
  return {
    dir,
    paths: {
      root: dir,
      tree: join(dir, "tree.v1.json"),
      annotations: join(dir, "annotations.v1.json"),
      settings: join(dir, "settings.v1.json"),
      trashIndex: join(dir, "trash", "index.v1.json"),
      trashDir: join(dir, "trash"),
      tmpDir: tmp,
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ── sidecar store ────────────────────────────────────────────────────────────

test("a missing document reads as the empty payload at revision 0", async () => {
  const box = await sandbox();
  try {
    const doc = createSidecar({ path: box.paths.tree, tmpDir: box.paths.tmpDir, empty: () => ({ folders: {} }) });
    const value = await doc.read();
    assert.deepEqual(value, { version: 1, revision: 0, folders: {} });
  } finally {
    await box.cleanup();
  }
});

test("a write bumps the revision and is visible to the next read", async () => {
  const box = await sandbox();
  try {
    const doc = createSidecar({ path: box.paths.tree, tmpDir: box.paths.tmpDir, empty: () => ({ folders: {} }) });
    const first = await doc.mutate((draft) => {
      draft.folders.a = { id: "a" };
    });
    assert.equal(first.revision, 1);
    const second = await doc.mutate((draft) => {
      draft.folders.b = { id: "b" };
    });
    assert.equal(second.revision, 2);
    assert.deepEqual(Object.keys((await doc.read()).folders).sort(), ["a", "b"]);
  } finally {
    await box.cleanup();
  }
});

test("a stale expected revision is refused and changes nothing", async () => {
  const box = await sandbox();
  try {
    const doc = createSidecar({ path: box.paths.tree, tmpDir: box.paths.tmpDir, empty: () => ({ folders: {} }) });
    await doc.mutate((draft) => {
      draft.folders.a = { id: "a" };
    });
    await assert.rejects(
      () => doc.mutate((draft) => { draft.folders.b = { id: "b" }; }, 0),
      (err) => err.code === "revision-conflict",
    );
    assert.deepEqual(Object.keys((await doc.read()).folders), ["a"]);
    // The failed write must not poison the queue.
    const next = await doc.mutate((draft) => { draft.folders.c = { id: "c" }; }, 1);
    assert.equal(next.revision, 2);
  } finally {
    await box.cleanup();
  }
});

test("concurrent writes are serialized instead of losing an update", async () => {
  const box = await sandbox();
  try {
    const doc = createSidecar({ path: box.paths.tree, tmpDir: box.paths.tmpDir, empty: () => ({ folders: {} }) });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        doc.mutate((draft) => {
          draft.folders[`f${index}`] = { id: `f${index}` };
        }),
      ),
    );
    const value = await doc.read();
    assert.equal(Object.keys(value.folders).length, 8);
    assert.equal(value.revision, 8);
  } finally {
    await box.cleanup();
  }
});

test("a corrupt document is quarantined and replaced by an empty one", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.paths.tree, "{ not json", "utf8");
    const doc = createSidecar({ path: box.paths.tree, tmpDir: box.paths.tmpDir, empty: () => ({ folders: {} }) });
    const value = await doc.read();
    assert.deepEqual(value.folders, {});
    const quarantined = (await readdir(box.paths.tmpDir)).filter((name) => name.includes("corrupt"));
    assert.equal(quarantined.length, 1);
  } finally {
    await box.cleanup();
  }
});

test("an unknown version is reported rather than silently overwritten", async () => {
  const box = await sandbox();
  try {
    await writeFile(box.paths.tree, JSON.stringify({ version: 99, revision: 3, folders: {} }), "utf8");
    const doc = createSidecar({ path: box.paths.tree, tmpDir: box.paths.tmpDir, empty: () => ({ folders: {} }) });
    await assert.rejects(() => doc.read(), (err) => err.code === "sidecar-version");
  } finally {
    await box.cleanup();
  }
});

test("the old array-shaped payload migrates instead of being discarded", async () => {
  const box = await sandbox();
  try {
    await writeFile(
      box.paths.tree,
      JSON.stringify({ version: 0, folders: [{ id: "d-a", name: "A" }, { id: "d-b", name: "B" }] }),
      "utf8",
    );
    const docs = openDocuments(box.paths);
    const value = await docs.tree.read();
    assert.deepEqual(Object.keys(value.folders).sort(), ["d-a", "d-b"]);
  } finally {
    await box.cleanup();
  }
});

test("writeAtomic leaves no temp file behind", async () => {
  const box = await sandbox();
  try {
    await writeAtomic(box.paths.settings, box.paths.tmpDir, "{}");
    assert.deepEqual(await readdir(box.paths.tmpDir), []);
    assert.equal(await readFile(box.paths.settings, "utf8"), "{}");
  } finally {
    await box.cleanup();
  }
});

test("the documents are independent files", async () => {
  const box = await sandbox();
  try {
    const docs = openDocuments(box.paths);
    await docs.tree.mutate((draft) => { draft.folders.x = { id: "x" }; });
    await docs.annotations.mutate((draft) => { draft.sessions.s1 = { tags: ["a"] }; });
    assert.equal((await docs.tree.read()).revision, 1);
    assert.equal((await docs.annotations.read()).revision, 1);
    assert.equal((await docs.settings.read()).revision, 0);
  } finally {
    await box.cleanup();
  }
});

// ── annotations ──────────────────────────────────────────────────────────────

test("tags are trimmed, de-duplicated case-insensitively and bounded", () => {
  assert.deepEqual(normalizeTags(["  逆向 ", "逆向", "UI", "ui"]), ["逆向", "UI"]);
  assert.deepEqual(normalizeTags("a, b ,a"), ["a", "b"]);
  assert.equal(normalizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`)).length, TAG_LIMIT);
  assert.equal(normalizeTags(["x".repeat(100)])[0].length, TAG_MAX_LENGTH);
  assert.deepEqual(normalizeTags(null), []);
});

test("an annotation with no content is deleted, not stored as an empty shell", () => {
  const document = { sessions: {} };
  patchAnnotation(document, "s1", { tags: ["a"] }, 1);
  assert.deepEqual(Object.keys(document.sessions), ["s1"]);
  patchAnnotation(document, "s1", { tags: [] }, 2);
  assert.deepEqual(Object.keys(document.sessions), []);
});

test("a patch merges into the existing annotation and stamps updatedAt", () => {
  const document = { sessions: {} };
  patchAnnotation(document, "s1", { tags: ["a"], note: "hello" }, 10);
  const next = patchAnnotation(document, "s1", { note: "changed" }, 20);
  assert.deepEqual(next.tags, ["a"]);
  assert.equal(next.note, "changed");
  assert.equal(next.updatedAt, 20);
});

test("favorite and todo are independent flags", () => {
  const document = { sessions: {} };
  patchAnnotation(document, "s1", { favorite: true }, 1);
  assert.deepEqual(idsWithFlag(document, "favorite"), ["s1"]);
  assert.deepEqual(idsWithFlag(document, "todo"), []);
  patchAnnotation(document, "s1", { todo: true }, 2);
  assert.deepEqual(idsWithFlag(document, "todo"), ["s1"]);
  patchAnnotation(document, "s1", { favorite: false }, 3);
  assert.deepEqual(idsWithFlag(document, "favorite"), []);
  assert.deepEqual(idsWithFlag(document, "todo"), ["s1"]);
});

test("an unknown priority degrades to none", () => {
  assert.equal(normalizeAnnotation({ priority: "urgent" }).priority, "none");
  assert.equal(normalizeAnnotation({ priority: "HIGH" }).priority, "high");
});

test("the tag index counts distinct sessions per tag, most used first", () => {
  const document = {
    sessions: {
      s1: { tags: ["逆向", "UI"] },
      s2: { tags: ["逆向"] },
      s3: { tags: ["UI"] },
    },
  };
  const index = tagIndex(document);
  assert.equal(index[0].count, 2);
  assert.deepEqual(index.map((row) => row.tag).sort(), ["UI", "逆向"]);
});

// ── folders ──────────────────────────────────────────────────────────────────

const registry = {
  workspaceIds: ["wa", "wb"],
  workspaces: new Map([
    ["wa", { id: "wa", title: "Alpha", path: "C:\\alpha" }],
    ["wb", { id: "wb", title: "Beta", path: "C:\\beta" }],
  ]),
  defaultWorkspaceId: "wb",
};

/** @param {object} [userTree] */
function treeWith(userTree) {
  return buildAutoTree({ registry, sessions: [], userTree });
}

test("createFolder validates its parent and appends after existing siblings", () => {
  const draft = { folders: {}, placement: {}, workspaceOrder: {} };
  const tree = treeWith();
  let counter = 0;
  const id = createFolder(draft, { name: "工作" }, tree, () => `id${(counter += 1)}`);
  assert.equal(id, "d-id1");
  assert.equal(draft.folders[id].parent, FIXED_NODES.root);
  assert.equal(draft.folders[id].order, 0);

  // A second folder under the same parent gets the next order.
  const tree2 = treeWith({ folders: draft.folders, placement: {} });
  const id2 = createFolder(draft, { name: "归档" }, tree2, () => `id${(counter += 1)}`);
  assert.equal(draft.folders[id2].order, 1);

  // A workspace cannot contain a folder.
  assert.throws(() => createFolder(draft, { name: "x", parent: "w-wa" }, tree2, () => "nope"), /workspace/);
  assert.throws(() => createFolder(draft, { name: "   " }, tree2, () => "nope"), /required/);
  assert.throws(() => createFolder(draft, { name: "x".repeat(100) }, tree2, () => "nope"), /longer than/);
});

test("renameFolder refuses fixed nodes and empty names", () => {
  const draft = { folders: { "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root } } };
  assert.equal(renameFolder(draft, "d-a", "  B  "), "B");
  assert.throws(() => renameFolder(draft, FIXED_NODES.root, "x"), /not a folder/);
  assert.throws(() => renameFolder(draft, "d-a", " "), /required/);
  assert.throws(() => renameFolder(draft, "d-missing", "x"), /unknown folder/);
});

test("moveNode places a workspace in a folder and lifts it back to the root", () => {
  const draft = { folders: { "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root } }, placement: {}, workspaceOrder: {} };
  moveNode(draft, "w-wa", "d-a");
  assert.equal(draft.placement.wa, "d-a");
  moveNode(draft, "w-wa", FIXED_NODES.root);
  assert.equal(draft.placement.wa, undefined);
});

test("deleteFolder refuses a non-empty folder unless the caller lifts the contents", () => {
  const draft = {
    folders: {
      "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root, order: 0 },
      "d-b": { id: "d-b", name: "B", parent: "d-a", order: 0 },
    },
    placement: { wa: "d-a" },
    workspaceOrder: {},
  };
  const tree = treeWith(draft);
  assert.throws(() => deleteFolder(draft, "d-a", tree), /still holds/);

  const result = deleteFolder(draft, "d-a", tree, { liftContents: true });
  assert.deepEqual(result.removed, ["d-a"]);
  assert.equal(draft.folders["d-a"], undefined);
  // The child folder and the workspace both moved up to the root.
  assert.equal(draft.folders["d-b"].parent, FIXED_NODES.root);
  assert.equal(draft.placement.wa, undefined);
});

test("reorderNode accepts folders and workspaces only", () => {
  const draft = { folders: { "d-a": { id: "d-a", name: "A", parent: FIXED_NODES.root } }, workspaceOrder: {} };
  assert.deepEqual(reorderNode(draft, "d-a", 5), { nodeId: "d-a", order: 5 });
  assert.deepEqual(reorderNode(draft, "w-wa", 2), { nodeId: "w-wa", order: 2 });
  assert.throws(() => reorderNode(draft, FIXED_NODES.trash, 1), /not reorderable/);
  assert.throws(() => reorderNode(draft, "d-a", Number.NaN), /must be a number/);
});

test("a folder created through the domain layer is immediately usable by canMove", () => {
  const draft = { folders: {}, placement: {}, workspaceOrder: {} };
  const before = treeWith();
  const id = createFolder(draft, { name: "工作" }, before, () => "work");
  const after = treeWith({ folders: draft.folders, placement: draft.placement });
  assert.equal(canMove("w-wa", id, after).ok, true);
  assert.equal(canMove(id, "w-wa", after).ok, false);
  // …and moving the folder into itself stays refused.
  assert.equal(canMove(id, id, after).ok, false);
});
