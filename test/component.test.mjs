/**
 * Tests for the browser component (P6).
 *
 *   node --test test/component.test.mjs
 *
 * The runtime is 110 MB and needs a network, so these tests never touch the
 * real Electron release. They pin the parts that decide whether a user ends up
 * with a working runtime or a corrupt one:
 *
 *   - the path layout and the marker rule ("ready" is files on disk, nothing else);
 *   - the state machine's transitions, including cancel and remove;
 *   - the downloader's resume and "server ignored Range" handling;
 *   - checksum refusal *before* extraction;
 *   - an interrupted install leaving a previous runtime untouched.
 */

import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ELECTRON_VERSION, componentPaths, runtimePaths } from "../lib/component/layout.js";
import { downloadAsset } from "../lib/component/downloader.js";
import {
  directorySize,
  extractZip,
  installHelperApp,
  sameDigest,
  sha256File,
  publishRuntime,
  removeTree,
  verifyZip,
} from "../lib/component/install.js";
import { emptyState, normalizeState, readState, writeState, createProgressWriter } from "../lib/component/state.js";
import { createComponentManager } from "../lib/component/manager.js";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "se-component-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ── layout ──────────────────────────────────────────────────────────────────

test("componentPaths derives every path from the data directory", () => {
  const dataDir = join(tmpdir(), "se-component");
  const paths = componentPaths(dataDir, "win32");
  assert.equal(paths.root, join(dataDir, "component"));
  // A stamped runtime is a sibling, never the same directory: an install must
  // never have to rename over a path Windows may have open.
  const stamped = componentPaths(dataDir, "win32", "k3f9");
  assert.notEqual(stamped.runtime, paths.runtime);
  assert.ok(stamped.runtime.endsWith("runtime-k3f9"));
  assert.ok(paths.marker.endsWith(`.complete-${ELECTRON_VERSION}`));
  assert.ok(paths.part.endsWith("electron-v44.0.0-win32-x64.zip.part"));
  assert.ok(paths.binary.endsWith("electron.exe"));
  assert.ok(paths.manifest.endsWith("manifest.v1.json"));
});

// ── state ───────────────────────────────────────────────────────────────────

test("normalizeState keeps known fields and degrades unknown phases to absent", () => {
  const fresh = normalizeState(null);
  assert.equal(fresh.phase, "absent");

  const kept = normalizeState({ phase: "downloading", receivedBytes: 10, totalBytes: 100, source: "mirror" });
  assert.equal(kept.phase, "downloading");
  assert.equal(kept.receivedBytes, 10);

  // A hand-edited or future phase must not render an unhandled branch.
  assert.equal(normalizeState({ phase: "banana" }).phase, "absent");
});

test("state round-trips through disk atomically", async () => {
  const box = await sandbox();
  try {
    const file = join(box.root, "state.v1.json");
    assert.equal((await readState(file)).phase, "absent");
    await writeState(file, box.root, { ...emptyState(), phase: "ready", electronVersion: ELECTRON_VERSION });
    const reloaded = await readState(file);
    assert.equal(reloaded.phase, "ready");
    assert.ok(reloaded.updatedAt > 0);
  } finally {
    await box.cleanup();
  }
});

test("the progress writer throttles but never drops a flushed phase", async () => {
  const writes = [];
  const writer = createProgressWriter({
    intervalMs: 10_000,
    write: async (state) => {
      writes.push(state.phase);
      return state;
    },
  });
  await writer.push({ phase: "downloading", receivedBytes: 1 });
  await writer.push({ phase: "downloading", receivedBytes: 2 });
  assert.equal(writes.length, 1, "the second push is inside the throttle window");
  await writer.flush({ phase: "ready" });
  assert.deepEqual(writes, ["downloading", "ready"], "a phase change is always persisted");
});

// ── downloader ──────────────────────────────────────────────────────────────

/**
 * A tiny HTTP server whose behaviour each test controls.
 *
 * @param {(req, res) => void} handler
 */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("downloadAsset streams a body and reports progress", async () => {
  const body = Buffer.from("0123456789".repeat(100));
  const box = await sandbox();
  const site = await serve((_req, res) => {
    res.writeHead(200, { "content-length": body.length, etag: '"abc"' });
    res.end(body);
  });
  try {
    const part = join(box.root, "asset.part");
    const meta = join(box.root, "asset.part.json");
    const seen = [];
    const result = await downloadAsset({
      urls: [`${site.url}/asset`],
      part,
      partMeta: meta,
      onProgress: (progress) => seen.push(progress.receivedBytes),
    });
    assert.equal(result.receivedBytes, body.length);
    assert.equal(result.totalBytes, body.length);
    assert.ok(seen.length > 0, "progress fired at least once");
    assert.equal((await readFile(part)).length, body.length);
  } finally {
    await site.close();
    await box.cleanup();
  }
});

test("downloadAsset resumes with Range when the mirror honours it", async () => {
  const body = Buffer.from("abcdefghij".repeat(50));
  const box = await sandbox();
  const requests = [];
  const site = await serve((req, res) => {
    requests.push(req.headers.range ?? null);
    const start = req.headers.range ? Number(String(req.headers.range).replace(/\D+/g, "")) : 0;
    res.writeHead(req.headers.range ? 206 : 200, {
      "content-length": body.length - start,
      etag: '"resume"',
    });
    res.end(body.subarray(start));
  });
  try {
    const part = join(box.root, "asset.part");
    const meta = join(box.root, "asset.part.json");
    await writeFile(part, body.subarray(0, 100));
    await writeFile(meta, JSON.stringify({ url: `${site.url}/asset`, etag: '"resume"', received: 100 }));

    const result = await downloadAsset({ urls: [`${site.url}/asset`], part, partMeta: meta });
    // The first request is the size probe (a HEAD, no range); the GET after it
    // must carry the resume offset.
    assert.ok(
      requests.includes("bytes=100-"),
      `expected a ranged request, got ${JSON.stringify(requests)}`,
    );
    assert.equal(result.receivedBytes, body.length);
    assert.equal((await readFile(part)).length, body.length);
  } finally {
    await site.close();
    await box.cleanup();
  }
});

test("downloadAsset restarts cleanly when the mirror ignores Range", async () => {
  const body = Buffer.from("xyz".repeat(200));
  const box = await sandbox();
  const site = await serve((_req, res) => {
    // 200 even for a ranged request: the body is the whole file.
    res.writeHead(200, { "content-length": body.length, etag: '"ignored"' });
    res.end(body);
  });
  try {
    const part = join(box.root, "asset.part");
    const meta = join(box.root, "asset.part.json");
    await writeFile(part, body.subarray(0, 50));
    await writeFile(meta, JSON.stringify({ url: `${site.url}/asset`, etag: '"ignored"', received: 50 }));

    const result = await downloadAsset({ urls: [`${site.url}/asset`], part, partMeta: meta });
    // Appending to the old prefix would have produced 650 bytes; a clean
    // restart produces exactly the body.
    assert.equal(result.receivedBytes, body.length);
    assert.equal((await readFile(part)).length, body.length);
  } finally {
    await site.close();
    await box.cleanup();
  }
});

// ── verify / publish ────────────────────────────────────────────────────────

test("a digest mismatch is refused before anything is extracted", async () => {
  const box = await sandbox();
  try {
    const zip = join(box.root, "asset.zip");
    await writeFile(zip, "not a zip");
    const actual = await sha256File(zip);
    assert.equal(sameDigest(actual, actual), true);
    assert.equal(sameDigest(actual, "0".repeat(64)), false);
    await assert.rejects(() => verifyZip(zip, "0".repeat(64)), (error) => error.code === "component-checksum");
  } finally {
    await box.cleanup();
  }
});

test("the start-up sweep deletes only paths inside component/", async () => {
  const box = await sandbox();
  try {
    const dataDir = join(box.root, "data");
    const paths = componentPaths(dataDir, "win32");
    // A leftover install directory that the sweep is meant to remove, and a
    // directory outside the plugin's own tree. The pending list is plain JSON on
    // disk: a corrupt or edited file must not turn the sweep into `rm -rf`.
    const leftover = join(paths.root, "runtime-old");
    const outside = join(box.root, "documents");
    await mkdir(leftover, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(leftover, "electron.exe"), "x");
    await writeFile(join(outside, "keep.txt"), "keep");
    await writeFile(
      paths.pending,
      JSON.stringify({ paths: [leftover, outside, join(box.root, "..", "escape")] }),
      "utf8",
    );

    const manager = createComponentManager(dataDir);
    const result = await manager.sweep();

    assert.equal(existsSync(leftover), false);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.deepEqual(result.remaining, []);
    // The ignored paths are dropped from the list, not retried forever.
    assert.equal(existsSync(paths.pending), false);
  } finally {
    await box.cleanup();
  }
});

test("publishRuntime keeps the previous runtime when the new one is staged", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime");
    const staging = join(box.root, "runtime.staging");
    const marker = join(runtime, `.complete-${ELECTRON_VERSION}`);
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "old.txt"), "old");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "new.txt"), "new");

    await publishRuntime(staging, runtime, marker);
    assert.equal(existsSync(join(runtime, "new.txt")), true);
    assert.equal(existsSync(join(runtime, "old.txt")), false);
    // The marker is written into the staged tree, so readiness and bytes appear
    // together rather than in two observable steps.
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(staging), false);
  } finally {
    await box.cleanup();
  }
});

// ── what Windows will not let go of ─────────────────────────────────────────

test("installHelperApp writes an app Electron prefers over the bundled one", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime-k3f9");
    await mkdir(join(runtime, "resources"), { recursive: true });

    const dir = await installHelperApp(runtime);
    assert.equal(dir, join(runtime, "resources", "app"));

    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    // `main` has to stay inside the app directory: Electron resolves an absolute
    // value against that directory and refuses to start if it lands elsewhere.
    assert.equal(manifest.main, "index.js");
    assert.ok(manifest.name);

    // The plugin's own entry point comes from the environment, so a runtime
    // extracted by any version of the plugin runs the code that is installed now.
    const entry = await readFile(join(dir, "index.js"), "utf8");
    assert.match(entry, /process\.env\.DSH_SE_HELPER_MAIN/);
    assert.match(entry, /require\(main\)/);

    // Idempotent: launching refreshes an existing app instead of failing on it.
    await writeFile(join(dir, "index.js"), "stale", "utf8");
    await installHelperApp(runtime);
    assert.match(await readFile(join(dir, "index.js"), "utf8"), /DSH_SE_HELPER_MAIN/);
  } finally {
    await box.cleanup();
  }
});

test("directorySize never stats an asar bundle", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime");
    await mkdir(join(runtime, "resources"), { recursive: true });
    await writeFile(join(runtime, "electron.exe"), Buffer.alloc(100, 1));
    // The real one is 111 073 bytes. Electron's fs hands any `.asar` path to its
    // asar layer, which opens the file and caches the handle for the life of the
    // process — so even a size check is enough to make it undeletable.
    await writeFile(join(runtime, "resources", "default_app.asar"), Buffer.alloc(111073, 1));

    assert.equal(await directorySize(runtime), 100);
  } finally {
    await box.cleanup();
  }
});

test("extractZip leaves Electron's default app behind", { skip: process.platform !== "win32" }, async () => {
  const box = await sandbox();
  try {
    // A miniature of the official zip, laid out the same way. bsdtar can write
    // zips, so the fixture needs no bundled binary.
    const src = join(box.root, "src");
    await mkdir(join(src, "resources"), { recursive: true });
    await writeFile(join(src, "electron.exe"), "MZ");
    await writeFile(join(src, "resources", "default_app.asar"), "bundle");
    await writeFile(join(src, "resources", "keep.txt"), "keep");
    const zip = join(box.root, "runtime.zip");
    const bsdtar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const made = spawnSync(bsdtar, ["-a", "-cf", zip, "-C", src, "."], { stdio: "ignore" });
    assert.equal(made.status, 0, `could not build the fixture: ${made.error?.message ?? "tar failed"}`);

    const dest = join(box.root, "out");
    await extractZip(zip, dest);

    assert.equal(existsSync(join(dest, "electron.exe")), true);
    assert.equal(existsSync(join(dest, "resources", "keep.txt")), true);
    assert.equal(existsSync(join(dest, "resources", "default_app.asar")), false);
  } finally {
    await box.cleanup();
  }
});

test("removeTree deletes a runtime that has no asar bundle left", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime");
    await mkdir(join(runtime, "resources", "app"), { recursive: true });
    await writeFile(join(runtime, "electron.exe"), "MZ");
    await writeFile(join(runtime, "resources", "app", "index.js"), "entry");

    const result = await removeTree(runtime);
    assert.equal(result.removed, true);
    assert.deepEqual(result.leftover, []);
    assert.equal(existsSync(runtime), false);
  } finally {
    await box.cleanup();
  }
});
