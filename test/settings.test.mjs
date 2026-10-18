/**
 * Settings document — defaults, merging and normalisation.
 *
 * The settings document is the one place where a bad value can leak into the UI
 * from disk, so every branch of `normalizeSettings` is checked here rather than
 * discovered in a screenshot.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DIM,
  MODAL_SIZES,
  OPEN_MODES,
  defaultSettings,
  mergeSettings,
  modalSizeOf,
  normalizeSettings,
} from "../lib/domain/settings.js";

test("defaults keep the panel plain: modal, medium, no scrim", () => {
  const settings = defaultSettings();
  assert.equal(settings.shell.openMode, "modal");
  assert.equal(settings.shell.modal.size, "md");
  // Hard constraint 10: a wallpaper must never be darkened by default.
  assert.equal(settings.shell.modal.dim, 0);
  assert.equal(settings.shell.modal.closeOnBackdrop, true);
  assert.equal(settings.shell.window.alwaysOnTop, false);
  assert.equal(settings.component.reuseOrbRuntime, true);
  assert.equal(settings.dataDir.current, null);
});

test("normalizeSettings always returns a complete document", () => {
  const settings = normalizeSettings(null);
  assert.deepEqual(settings, defaultSettings());
  assert.deepEqual(normalizeSettings({}), defaultSettings());
  assert.deepEqual(normalizeSettings("nonsense"), defaultSettings());
});

test("open modes and modal sizes are closed vocabularies", () => {
  for (const mode of OPEN_MODES) {
    assert.equal(normalizeSettings({ shell: { openMode: mode } }).shell.openMode, mode);
  }
  assert.equal(normalizeSettings({ shell: { openMode: "detached-window" } }).shell.openMode, "modal");

  for (const size of MODAL_SIZES) {
    assert.equal(normalizeSettings({ shell: { modal: { size } } }).shell.modal.size, size);
  }
  assert.equal(normalizeSettings({ shell: { modal: { size: "huge" } } }).shell.modal.size, "md");
});

test("the scrim is clamped to [0, MAX_DIM]", () => {
  assert.equal(normalizeSettings({ shell: { modal: { dim: 0.35 } } }).shell.modal.dim, 0.35);
  assert.equal(normalizeSettings({ shell: { modal: { dim: -1 } } }).shell.modal.dim, 0);
  assert.equal(normalizeSettings({ shell: { modal: { dim: 4 } } }).shell.modal.dim, MAX_DIM);
  assert.equal(normalizeSettings({ shell: { modal: { dim: "0.5" } } }).shell.modal.dim, 0);
  assert.equal(MAX_DIM, 0.8);
});

test("pageSize and defaultView fall back instead of echoing junk", () => {
  assert.equal(normalizeSettings({ pageSize: 500 }).pageSize, 500);
  assert.equal(normalizeSettings({ pageSize: 19 }).pageSize, 200);
  assert.equal(normalizeSettings({ pageSize: 2001 }).pageSize, 200);
  assert.equal(normalizeSettings({ pageSize: "big" }).pageSize, 200);
  assert.equal(normalizeSettings({ defaultView: "icons" }).defaultView, "icons");
  assert.equal(normalizeSettings({ defaultView: "tree" }).defaultView, "details");
});

test("a data directory is only remembered when it is a non-empty string", () => {
  assert.equal(normalizeSettings({ dataDir: { current: "C:/tmp/se" } }).dataDir.current, "C:/tmp/se");
  assert.equal(normalizeSettings({ dataDir: { current: "   " } }).dataDir.current, null);
  assert.equal(normalizeSettings({ dataDir: { current: 42 } }).dataDir.current, null);
});

test("mergeSettings keeps known keys and drops unknown ones", () => {
  const merged = mergeSettings(defaultSettings(), {
    pageSize: 500,
    nonsense: true,
    shell: { modal: { dim: 0.2 } },
  });
  assert.equal(merged.pageSize, 500);
  assert.equal(merged.shell.modal.dim, 0.2);
  // Sibling keys survive a partial nested patch.
  assert.equal(merged.shell.modal.size, "md");
  assert.equal(merged.shell.openMode, "modal");
  assert.equal("nonsense" in merged, false);
});

test("mergeSettings does not mutate the document it was given", () => {
  const base = defaultSettings();
  const before = JSON.stringify(base);
  mergeSettings(base, { shell: { openMode: "window", modal: { dim: 0.4 } } });
  assert.equal(JSON.stringify(base), before);
});

test("modal presets map to the documented sizes", () => {
  assert.deepEqual(modalSizeOf("sm"), { width: "900px", height: "600px" });
  assert.deepEqual(modalSizeOf("md"), { width: "1100px", height: "720px" });
  assert.deepEqual(modalSizeOf("lg"), { width: "1280px", height: "800px" });
  assert.deepEqual(modalSizeOf("full"), { width: "96%", height: "92%" });
  assert.deepEqual(modalSizeOf("unknown"), modalSizeOf("md"));
});
