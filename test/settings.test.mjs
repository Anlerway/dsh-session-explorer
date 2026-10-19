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
  MODAL_FIXED_SIZES,
  MODAL_PERCENT_SIZES,
  MODAL_PRESENTATIONS,
  MODAL_SIZING,
  OPEN_MODES,
  defaultSettings,
  mergeSettings,
  modalSizeOf,
  normalizeSettings,
} from "../lib/domain/settings.js";

test("defaults keep the panel plain: modal, fixed medium, no scrim", () => {
  const settings = defaultSettings();
  assert.equal(settings.shell.openMode, "modal");
  assert.equal(settings.shell.modal.presentation, "float");
  assert.equal(settings.shell.modal.sizing, "fixed");
  assert.equal(settings.shell.modal.size, "md");
  assert.equal(settings.shell.modal.percent, "p70");
  // Hard constraint 10: a wallpaper must never be darkened by default.
  assert.equal(settings.shell.modal.dim, 0);
  assert.equal(settings.shell.modal.closeOnBackdrop, true);
  assert.equal(settings.shell.window.alwaysOnTop, false);
  // The Electron component (and its "reuse dsh-orb's runtime" flag) is gone:
  // the plugin is a pure web plugin now and stores no runtime preference.
  assert.equal("component" in settings, false);
  assert.equal(settings.dataDir.current, null);
});

test("normalizeSettings always returns a complete document", () => {
  const settings = normalizeSettings(null);
  assert.deepEqual(settings, defaultSettings());
  assert.deepEqual(normalizeSettings({}), defaultSettings());
  assert.deepEqual(normalizeSettings("nonsense"), defaultSettings());
});

test("open modes, sizing modes and presets are closed vocabularies", () => {
  for (const mode of OPEN_MODES) {
    assert.equal(normalizeSettings({ shell: { openMode: mode } }).shell.openMode, mode);
  }
  assert.equal(normalizeSettings({ shell: { openMode: "detached-window" } }).shell.openMode, "modal");
  // The abandoned separate-window mode degrades to the in-app modal instead of
  // leaving a stored setting the UI can no longer open.
  assert.equal(normalizeSettings({ shell: { openMode: "detached" } }).shell.openMode, "modal");

  for (const sizing of MODAL_SIZING) {
    assert.equal(normalizeSettings({ shell: { modal: { sizing } } }).shell.modal.sizing, sizing);
  }
  assert.equal(normalizeSettings({ shell: { modal: { sizing: "auto" } } }).shell.modal.sizing, "fixed");

  for (const presentation of MODAL_PRESENTATIONS) {
    assert.equal(normalizeSettings({ shell: { modal: { presentation } } }).shell.modal.presentation, presentation);
  }
  assert.equal(normalizeSettings({ shell: { modal: { presentation: "dialog" } } }).shell.modal.presentation, "float");

  for (const size of MODAL_FIXED_SIZES) {
    assert.equal(normalizeSettings({ shell: { modal: { size } } }).shell.modal.size, size);
  }
  assert.equal(normalizeSettings({ shell: { modal: { size: "huge" } } }).shell.modal.size, "md");

  for (const percent of MODAL_PERCENT_SIZES) {
    assert.equal(normalizeSettings({ shell: { modal: { percent } } }).shell.modal.percent, percent);
  }
  assert.equal(normalizeSettings({ shell: { modal: { percent: "p12" } } }).shell.modal.percent, "p70");
});

test("a settings file from the old size vocabulary still yields a usable size", () => {
  // The previous build wrote size "full"; that used to mean "a share of the
  // viewport", so it must land in the percent branch rather than be discarded.
  const migrated = normalizeSettings({ shell: { modal: { size: "full" } } });
  assert.equal(migrated.shell.modal.sizing, "percent");
  assert.equal(migrated.shell.modal.percent, "p100");
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

test("a fixed preset is clamped to the viewport", () => {
  assert.deepEqual(modalSizeOf({ sizing: "fixed", size: "sm" }), {
    width: "min(860px, 94vw)",
    height: "min(560px, 90vh)",
  });
  assert.deepEqual(modalSizeOf({ sizing: "fixed", size: "md" }), {
    width: "min(1100px, 94vw)",
    height: "min(720px, 90vh)",
  });
  // An unknown preset falls back rather than producing an empty box.
  assert.deepEqual(modalSizeOf({ sizing: "fixed", size: "huge" }), modalSizeOf({ sizing: "fixed" }));
  assert.deepEqual(modalSizeOf(null), modalSizeOf({ sizing: "fixed" }));
});

test("a percentage preset follows the viewport", () => {
  assert.deepEqual(modalSizeOf({ sizing: "percent", percent: "p50" }), { width: "50vw", height: "50vh" });
  assert.deepEqual(modalSizeOf({ sizing: "percent", percent: "p85" }), { width: "85vw", height: "85vh" });
  assert.deepEqual(modalSizeOf({ sizing: "percent", percent: "p100" }), { width: "100vw", height: "100vh" });
  assert.deepEqual(modalSizeOf({ sizing: "percent" }), { width: "70vw", height: "70vh" });
});
