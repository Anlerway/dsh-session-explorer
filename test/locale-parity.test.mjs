/**
 * The two dictionaries, held against each other.
 *
 * A missing key is invisible in Chinese and obvious in English: `t()` answers the
 * key itself, so an English user sees `setResetHint` printed on the page while a
 * Chinese user sees a sentence. Nobody sees it in review, either — the two blocks
 * are five hundred lines apart.
 *
 * So the parity is asserted rather than trusted: same keys, no empty strings, the
 * same `{placeholders}`, and an English string short enough to sit in a row next
 * to a button.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: api } = loadClientBundle({ expose: ["ZH", "EN"] });
const { ZH, EN } = api;

const keysOf = (dictionary) => Object.keys(dictionary).sort();
const placeholdersOf = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("both dictionaries carry exactly the same keys", () => {
  const zh = keysOf(ZH);
  const en = keysOf(EN);
  const missingInEnglish = zh.filter((key) => !(key in EN));
  const missingInChinese = en.filter((key) => !(key in ZH));
  assert.deepEqual(missingInEnglish, [], "keys present in zh but not en");
  assert.deepEqual(missingInChinese, [], "keys present in en but not zh");
  assert.ok(zh.length > 100, "the dictionaries should still be dictionaries");
});

test("no copy is an empty string", () => {
  for (const [name, dictionary] of [["zh", ZH], ["en", EN]]) {
    const empty = Object.entries(dictionary)
      .filter(([, value]) => typeof value !== "string" || value.trim() === "")
      .map(([key]) => key);
    assert.deepEqual(empty, [], `${name} has copy that renders as nothing`);
  }
});

test("a value's placeholders are the same in both languages", () => {
  for (const key of keysOf(ZH)) {
    assert.deepEqual(
      placeholdersOf(EN[key]),
      placeholdersOf(ZH[key]),
      `${key} interpolates different things in each language`,
    );
  }
});

test("English copy stays short enough for a settings row", () => {
  // The settings page puts copy beside a button in a ~600px window; a hint that
  // needs three lines is a paragraph where the product wanted a label. Scoped to
  // the 关于 and 危险操作 groups, whose copy was rewritten to be one line each —
  // older groups are a longer job and are not claims this test makes.
  const LABELS = [
    "setGroupAbout", "setVersion", "setCheckUpdate", "setChecking", "setUpdateAvailable",
    "setUpdateLatest", "setUpdateNone", "setDownload", "setCacheClear", "setCacheGo",
    "setCacheClearing", "setCacheFreed", "setCacheFreedNone", "setStar", "setStarGo",
    "setIssue", "setIssueGo", "setGroupDanger", "setReset", "setResetGo",
    "setResetTyped", "setResetCancel", "setResetConfirm", "setResetBusy", "setResetDone",
  ];
  const HINTS = [
    "setCacheClearHint", "setCacheSkipped", "setCacheFailed", "setStarHint",
    "setUpdateFailed", "setLinkFailed", "setResetHint", "setResetFailed",
  ];
  const tooLong = [
    ...LABELS.filter((key) => EN[key].length > 40).map((key) => `label ${key}: ${EN[key].length}`),
    ...HINTS.filter((key) => EN[key].length > 96).map((key) => `hint ${key}: ${EN[key].length}`),
  ];
  assert.deepEqual(tooLong, [], "English copy that will not fit beside a button");
});

test("the settings page declares the red it paints danger with", () => {
  // The page mounts outside .se-shell, so it has its own token block. Forgetting
  // --sm-danger there does not fail loudly: color-mix over an invalid variable is
  // invalid too, the declaration is dropped, and the danger group renders in the
  // ordinary grey — which is exactly how this shipped once.
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const start = source.indexOf("\n.se-set{");
  assert.ok(start > 0, "the .se-set token block is gone");
  const block = source.slice(start, source.indexOf("\n}", start));
  assert.match(block, /--sm-danger:/, "the settings page needs its own --sm-danger");
  assert.match(block, /--sm-border-soft:/, "and the rest of its tokens");
});
