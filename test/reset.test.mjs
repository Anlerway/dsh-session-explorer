/**
 * 清除数据 — the host half of the one irreversible button in this plugin.
 *
 * The page tests can see that the right word is typed and that the right route
 * is called; they cannot see what actually disappears from disk. That is the
 * part that matters here, so every case below works on a real data directory
 * with a real sidecar set: folders, tags, a bin entry with a session payload
 * behind it, a quarantine file and a tmp leftover.
 *
 * The two things this must never do are pinned as hard as the ones it must:
 * emptying the directory it lives in, and taking the browser component with it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dataPaths } from "../lib/paths.js";
import { openDocuments } from "../lib/store/documents.js";
import { resetData, RESET_CONFIRMATION } from "../lib/host/reset.js";

/** A migrated install: four documents with content, a bin with a session in it,
 *  a quarantined parse failure, a tmp leftover, and the browser component. */
async function makeInstall() {
  const dir = mkdtempSync(join(tmpdir(), "se-reset-"));
  const paths = dataPaths(dir);
  mkdirSync(paths.trashDir, { recursive: true });
  mkdirSync(paths.tmpDir, { recursive: true });
  mkdirSync(paths.quarantine, { recursive: true });

  const documents = openDocuments(paths);
  await documents.tree.mutate((draft) => {
    draft.folders = { f1: { id: "f1", name: "工作", parent: null, order: 0 } };
  });
  await documents.annotations.mutate((draft) => {
    draft.tags = ["重要"];
    draft.sessions = { s1: { tags: ["重要"], note: "记得回来" } };
  });
  await documents.settings.mutate((draft) => {
    // Deliberately not dataDir.current: the plain wipe is the default case, and
    // the migrated install gets its own test below.
    draft.list.showArchived = false;
  });
  await documents.trash.mutate((draft) => {
    draft.entries = { s1: { id: "s1", from: "C:/dsh/sessions/s1", deletedAt: 1 } };
  });

  // The bin is a move, not a copy: this directory used to be a DSH session.
  mkdirSync(join(paths.trashDir, "s1"), { recursive: true });
  writeFileSync(join(paths.trashDir, "s1", "session.jsonl"), "s".repeat(512));
  writeFileSync(join(paths.quarantine, "tree.v1.json.corrupt-1"), "bad bytes");
  writeFileSync(join(paths.tmpDir, "tree.v1.json.42.tmp"), "half written");

  // The optional browser component: an install, not user data.
  mkdirSync(join(dir, "component", "download"), { recursive: true });
  writeFileSync(join(dir, "component", "download", "electron.zip.part"), "p".repeat(64));
  mkdirSync(join(dir, ".component-staging", "runtime"), { recursive: true });
  writeFileSync(join(dir, ".component-staging", "runtime", "chrome.exe"), "c".repeat(32));

  const calls = [];
  const api = {
    dataDir: dir,
    paths,
    documents,
    calls,
    reader: { invalidate: () => calls.push("sessions") },
  };
  return { dir, paths, documents, api, calls };
}

const sidecars = (paths) => [paths.tree, paths.annotations, paths.settings, paths.trashIndex];

test("the word is checked before anything is read, let alone deleted", async () => {
  const { paths, api } = await makeInstall();
  assert.equal(RESET_CONFIRMATION, "DELETE");

  for (const confirm of [undefined, null, "", "delete", "Delete", "DELETE!", "DELET", 42, {}]) {
    await assert.rejects(
      () => resetData(api, { confirm }),
      (error) => error.code === "confirm-required",
      "refused: " + String(confirm),
    );
  }
  // A no-op, not a half-applied one: the documents are all still there.
  for (const path of sidecars(paths)) assert.ok(existsSync(path), "survived: " + path);
  assert.equal(readdirSync(paths.trashDir).length > 0, true, "the bin is untouched");
});

test("whitespace around the word is tolerated, because the client trims too", async () => {
  const { api, paths } = await makeInstall();
  const result = await resetData(api, { confirm: "  DELETE\n" });
  assert.equal(result.keptLocation, null);
  assert.equal(existsSync(paths.tree), false);
});

test("DELETE takes the records, the bin's payloads, the quarantine and the tmp", async () => {
  const { dir, paths, api } = await makeInstall();
  const result = await resetData(api, { confirm: "DELETE" });

  for (const path of sidecars(paths)) assert.equal(existsSync(path), false, "deleted: " + path);

  // The bin held a whole session directory; it is gone, and so is everything in it.
  assert.deepEqual(readdirSync(paths.trashDir), []);
  assert.equal(existsSync(join(paths.trashDir, "s1")), false);
  assert.deepEqual(readdirSync(paths.quarantine), []);
  assert.deepEqual(readdirSync(paths.tmpDir), []);

  for (const name of ["tree", "annotations", "settings", "trash"]) {
    assert.equal(result.documents[name].removed, true, "reported removed: " + name);
    assert.ok(result.documents[name].bytes > 0, "reported bytes: " + name);
  }
  // One entry, not two: the bin's index.v1.json was already deleted as a
  // document, so emptying trash/ only finds the session directory.
  assert.equal(result.trash.removed, 1, "the session directory behind the bin entry");
  assert.equal(result.quarantine.removed, 1);
  assert.equal(result.tmp.removed, 1);
  assert.equal(result.dataDir, dir);

  // Every byte claimed was either a document or a directory emptied above.
  const parts =
    Object.values(result.documents).reduce((sum, entry) => sum + entry.bytes, 0) +
    result.trash.bytes +
    result.quarantine.bytes +
    result.tmp.bytes;
  assert.equal(result.freedBytes, parts);
  assert.ok(result.freedBytes >= 512, "the bin payload is counted, not just the index");
});

test("the directory itself survives, so the plugin still has somewhere to write", async () => {
  const { dir, paths, api } = await makeInstall();
  await resetData(api, { confirm: "DELETE" });

  assert.ok(existsSync(dir), "the data directory is not deleted");
  for (const child of [paths.trashDir, paths.tmpDir, paths.quarantine]) {
    assert.ok(existsSync(child), "emptied, not removed: " + child);
  }
});

test("the browser component is left alone — it is an install, not user data", async () => {
  const { dir, api } = await makeInstall();
  await resetData(api, { confirm: "DELETE" });

  // 清理缓存 owns these bytes; 清除数据 must not take a working browser with it.
  assert.ok(existsSync(join(dir, "component", "download", "electron.zip.part")));
  assert.ok(existsSync(join(dir, ".component-staging", "runtime", "chrome.exe")));
});

test("a migrated install keeps its recorded location across the wipe", async () => {
  const { paths, documents, api } = await makeInstall();
  const moved = mkdtempSync(join(tmpdir(), "se-reset-elsewhere-"));
  await documents.settings.mutate((draft) => {
    draft.dataDir = { current: moved };
  });

  const result = await resetData(api, { confirm: "DELETE" });
  assert.equal(result.keptLocation, moved);

  // The settings document was deleted and written again from nothing, holding
  // the location and nothing else — a fresh document is revision 1.
  const settings = await documents.settings.read();
  assert.equal(settings.revision, 1);
  assert.equal(settings.dataDir.current, moved);
  assert.deepEqual(settings.shell.open, { mode: "panel" }, "everything else is the default again");
  assert.ok(existsSync(paths.settings));
});

test("a first run with no documents at all clears nothing and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "se-reset-empty-"));
  const paths = dataPaths(dir);
  const calls = [];
  const api = { dataDir: dir, paths, documents: openDocuments(paths), calls, reader: { invalidate: () => calls.push("sessions") } };

  const result = await resetData(api, { confirm: "DELETE" });
  assert.equal(result.freedBytes, 0);
  assert.deepEqual(result.documents.tree, { removed: false, bytes: 0 });
  assert.equal(result.keptLocation, null);
});

test("every memoised list is dropped, or the deleted folders would still answer", async () => {
  const { api, calls, documents } = await makeInstall();
  const invalidated = [];
  // The four documents only: `openDocuments` also carries a `paths` property,
  // which is not a sidecar and has nothing to invalidate.
  for (const name of ["tree", "annotations", "settings", "trash"]) {
    const original = documents[name].invalidate;
    documents[name].invalidate = () => {
      invalidated.push(name);
      original();
    };
  }

  await resetData(api, { confirm: "DELETE" });
  assert.deepEqual(calls, ["sessions"]);
  assert.deepEqual(invalidated.sort(), ["annotations", "settings", "trash", "tree"]);
});

test("an unusable data directory is refused, even with the right word", async () => {
  const root = process.platform === "win32" ? "C:\\" : "/";
  for (const dataDir of [root, "", null]) {
    const api = { dataDir, documents: {}, reader: { invalidate() {} } };
    await assert.rejects(
      () => resetData(api, { confirm: "DELETE" }),
      (error) => error.code === "reset-refused",
      "refused: " + String(dataDir),
    );
  }
});
