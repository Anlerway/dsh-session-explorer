/**
 * Settings document — defaults, merging and normalisation.
 *
 * The settings document is the one place where a bad value can leak into the UI
 * from disk, so every branch of `normalizeSettings` is checked here rather than
 * discovered in a screenshot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, parse } from "node:path";

import {
  HEADER_STYLES,
  MAX_DIM,
  MODAL_FIXED_SIZES,
  MODAL_PERCENT_SIZES,
  MODAL_SIZING,
  OPEN_MODES,
  SUBAGENT_MODES,
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
  // 默认打开方式 defaults to 浮窗: the detached window needs the browser
  // component, and a launch that lands nowhere is worse than a modest one.
  assert.equal(settings.shell.open.mode, "panel");
  assert.deepEqual([...OPEN_MODES], ["panel", "detached"]);
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

test("默认打开方式 is a closed vocabulary of two launch modes", () => {
  // Both real modes survive.
  for (const mode of OPEN_MODES) {
    assert.equal(normalizeSettings({ shell: { open: { mode } } }).shell.open.mode, mode);
  }
  // Anything else — including a hand-edited file, and the retired shell.openMode
  // that used to hold the same vocabulary one level up — lands on 浮窗 instead
  // of reaching the launch path as an unknown string.
  for (const legacy of ["window", "detached-window", "float", "auto", "nonsense", 42]) {
    assert.equal(normalizeSettings({ shell: { open: { mode: legacy } } }).shell.open.mode, "panel");
  }
  assert.equal(normalizeSettings({ shell: { openMode: "detached" } }).shell.open.mode, "panel");
});

test("a launch-mode patch merges without disturbing the modal group", () => {
  const merged = mergeSettings(defaultSettings(), { shell: { open: { mode: "detached" } } });
  assert.equal(merged.shell.open.mode, "detached");
  assert.equal(merged.shell.modal.sizing, "fixed");
  assert.equal(merged.shell.modal.size, "md");
});

test("会话界面按钮样式 is a closed vocabulary, defaulting to 自动", () => {
  // A document written before the key existed keeps the responsive behaviour
  // the strip always had, not a surprise icon-only bar.
  assert.equal(defaultSettings().shell.header.style, "auto");
  assert.equal(normalizeSettings({}).shell.header.style, "auto");
  assert.deepEqual([...HEADER_STYLES], ["auto", "icon"]);
  for (const style of HEADER_STYLES) {
    assert.equal(normalizeSettings({ shell: { header: { style } } }).shell.header.style, style);
  }
  // Anything else falls back instead of reaching the strip as an unknown value.
  for (const bad of ["icons", "text", "", true, 1]) {
    assert.equal(normalizeSettings({ shell: { header: { style: bad } } }).shell.header.style, "auto");
  }
});

test("a header-style patch merges without disturbing its siblings", () => {  const merged = mergeSettings(defaultSettings(), { shell: { header: { style: "icon" } } });
  assert.equal(merged.shell.header.style, "icon");
  assert.equal(merged.shell.open.mode, "panel");
  assert.equal(merged.shell.modal.size, "md");
  // A later patch that only touches 打开方式 keeps the saved button style.
  const again = mergeSettings(merged, { shell: { open: { mode: "detached" } } });
  assert.equal(again.shell.header.style, "icon");
});

test("折叠子智能体 and 过滤空会话 are switches, both on by default", () => {
  // Folded is the default because a child is not a session the user can act on:
  // a run that delegated ten times must not push ten dead rows into the list.
  assert.equal(defaultSettings().list.collapseSubagents, true);
  assert.equal(normalizeSettings({}).list.collapseSubagents, true);
  assert.equal(normalizeSettings({ list: { collapseSubagents: false } }).list.collapseSubagents, false);
  // A non-boolean is not a choice: it falls back to the default instead of
  // being coerced, so a hand-edited file cannot invent a third state.
  for (const bad of ["expanded", 0, 1, null]) {
    assert.equal(normalizeSettings({ list: { collapseSubagents: bad } }).list.collapseSubagents, true);
  }
  // A document from the picker era stored a mode word; it must not reset the
  // user's 展开 choice back to folded on upgrade.
  assert.equal(normalizeSettings({ list: { subagents: "expanded" } }).list.collapseSubagents, false);
  assert.equal(normalizeSettings({ list: { subagents: "collapsed" } }).list.collapseSubagents, true);
  // The new switch wins over a stale mode word in the same document.
  assert.equal(
    normalizeSettings({ list: { subagents: "collapsed", collapseSubagents: false } }).list.collapseSubagents,
    false,
  );

  // 过滤空会话 hides a session that never started a turn; on by default, and
  // only an explicit `false` turns it off.
  assert.equal(defaultSettings().list.hideBlank, true);
  assert.equal(normalizeSettings({}).list.hideBlank, true);
  assert.equal(normalizeSettings({ list: { hideBlank: false } }).list.hideBlank, false);
  for (const bad of ["yes", 0, 1, null]) {
    assert.equal(normalizeSettings({ list: { hideBlank: bad } }).list.hideBlank, true);
  }

  // The list group merges as one shallow object, so a later toggle keeps it.
  const merged = mergeSettings(defaultSettings(), { list: { collapseSubagents: false } });
  assert.equal(merged.list.collapseSubagents, false);
  assert.equal(merged.list.showArchived, true);
  assert.equal(mergeSettings(merged, { list: { showArchived: false } }).list.collapseSubagents, false);
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

test("a data directory is remembered only when it is a place the plugin may own", () => {
  assert.equal(normalizeSettings({ dataDir: { current: "C:/tmp/se" } }).dataDir.current, "C:/tmp/se");
  assert.equal(normalizeSettings({ dataDir: { current: "   " } }).dataDir.current, null);
  assert.equal(normalizeSettings({ dataDir: { current: 42 } }).dataDir.current, null);
  // The string decides where a recursive delete runs, so a filesystem root and
  // DSH's own tree are refused here instead of being echoed back to the UI.
  assert.equal(normalizeSettings({ dataDir: { current: parse(process.cwd()).root } }).dataDir.current, null);
  assert.equal(normalizeSettings({ dataDir: { current: join(homedir(), ".dsh", "sessions") } }).dataDir.current, null);
  assert.equal(normalizeSettings({ dataDir: { current: homedir() } }).dataDir.current, null);
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
