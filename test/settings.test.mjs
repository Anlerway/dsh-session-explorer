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
  MODAL_SIZING,
  defaultSettings,
  mergeSettings,
  modalSizeOf,
  normalizeBounds,
  normalizeSettings,
} from "../lib/domain/settings.js";

test("defaults keep the panel plain: 浮窗, fixed medium, no scrim", () => {
  const settings = defaultSettings();
  assert.equal(settings.shell.modal.sizing, "fixed");
  assert.equal(settings.shell.modal.size, "md");
  assert.equal(settings.shell.modal.percent, "p70");
  // Hard constraint 10: a wallpaper must never be darkened by default.
  assert.equal(settings.shell.modal.dim, 0);
  assert.equal(settings.shell.modal.closeOnBackdrop, true);
  assert.equal(settings.shell.window.alwaysOnTop, false);
  assert.equal(settings.shell.window.bounds, null);
  // The plugin stores no runtime preference: the browser component is not
  // shared with, or adopted from, any other plugin.
  assert.equal("component" in settings, false);
  // 独立窗口 is opened from the titlebar, not from a setting, so the document
  // carries no presentation mode at all.
  assert.equal("openMode" in settings.shell, false);
  // The retired "native modal" axis is gone too: it lived on shell.modal.
  assert.equal("presentation" in settings.shell.modal, false);
  assert.equal(settings.dataDir.current, null);
});

test("normalizeSettings always returns a complete document", () => {
  const settings = normalizeSettings(null);
  assert.deepEqual(settings, defaultSettings());
  assert.deepEqual(normalizeSettings({}), defaultSettings());
  assert.deepEqual(normalizeSettings("nonsense"), defaultSettings());
});

test("a retired open mode is dropped instead of being echoed back", () => {
  // 独立窗口 used to be a setting. It is not any more: the panel is always the
  // floating card, and a detached window is opened from the titlebar. A stored
  // mode from an earlier build must not survive normalisation.
  for (const legacy of ["modal", "detached", "detached-window", "window", "float", "nonsense"]) {
    assert.equal("openMode" in normalizeSettings({ shell: { openMode: legacy } }).shell, false);
  }
});

test("sizing modes and presets are closed vocabularies", () => {
  for (const sizing of MODAL_SIZING) {
    assert.equal(normalizeSettings({ shell: { modal: { sizing } } }).shell.modal.sizing, sizing);
  }
  assert.equal(normalizeSettings({ shell: { modal: { sizing: "auto" } } }).shell.modal.sizing, "fixed");

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

test("remembered window bounds are validated, not echoed", () => {
  const good = normalizeBounds({ left: 10.4, top: 20.6, width: 900, height: 600 });
  assert.deepEqual(good, { left: 10, top: 21, width: 900, height: 600 });
  // Unusable shapes fall back to null instead of reaching the DOM as a style.
  assert.equal(normalizeBounds(null), null);
  assert.equal(normalizeBounds({}), null);
  assert.equal(normalizeBounds({ left: 0, top: 0, width: 10, height: 10 }), null);
  assert.equal(normalizeBounds({ left: "x", top: 0, width: 900, height: 600 }), null);
  assert.equal(normalizeSettings({ shell: { window: { bounds: good } } }).shell.window.bounds.left, 10);
  // Bounds used to live on shell.modal.bounds; they are folded over.
  assert.equal(normalizeSettings({ shell: { modal: { bounds: good } } }).shell.window.bounds.width, 900);
});

test("a data directory is only remembered when it is a non-empty string", () => {
  assert.equal(normalizeSettings({ dataDir: { current: "C:/tmp/se" } }).dataDir.current, "C:/tmp/se");
  assert.equal(normalizeSettings({ dataDir: { current: "   " } }).dataDir.current, null);
  assert.equal(normalizeSettings({ dataDir: { current: 42 } }).dataDir.current, null);
});

test("mergeSettings keeps known keys and drops unknown ones", () => {
  const merged = mergeSettings(defaultSettings(), {
    nonsense: true,
    shell: { modal: { dim: 0.2 } },
  });
  assert.equal(merged.shell.modal.dim, 0.2);
  // Sibling keys survive a partial nested patch.
  assert.equal(merged.shell.modal.size, "md");
  assert.equal("nonsense" in merged, false);
});

test("mergeSettings does not mutate the document it was given", () => {
  const base = defaultSettings();
  const before = JSON.stringify(base);
  mergeSettings(base, { shell: { modal: { dim: 0.4 } } });
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
