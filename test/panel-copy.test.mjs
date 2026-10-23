
/**
 * The panel's English copy: every Chinese label the panel draws has a line in
 * `panelDict`, and no Chinese literal is left standing outside it.
 *
 * The panel and the detached window share one render tree, so a label that never
 * went through `T()` is invisible in Chinese review and obvious in English use:
 * it shows Chinese in an English window. This file is the guard against that.
 *
 * @module test/panel-copy
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadClientBundle } from "./support/client-bundle.mjs";

const here = (path) => new URL("../" + path, import.meta.url);
const read = (path) => readFileSync(here(path), "utf8");

const CLIENT = read("lib/client.js");
const { test: internals } = loadClientBundle({ expose: ["panelDict", "T", "FIXED_META"] });

/** @returns {Map<string, string>} */
const dictionary = () => internals.panelDict();

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/**
 * Every string literal in the source, with the offset it starts at.
 *
 * Comments are skipped, because the plugin's comments are Chinese and always
 * have been: they are for the person reading the file, not the person using it.
 *
 * @param {string} code
 * @returns {{ start: number, text: string, quote: string }[]}
 */
function literals(code) {
  const found = [];
  let i = 0;
  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let j = i + 1;
      let text = "";
      while (j < code.length && code[j] !== quote) {
        if (code[j] === "\\") {
          text += code[j];
          j += 1;
          if (j < code.length) text += code[j];
          j += 1;
          continue;
        }
        text += code[j];
        j += 1;
      }
      found.push({ start: i, text, quote });
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

/**
 * The ranges the dictionaries occupy: their keys are Chinese on purpose.
 *
 * @param {string} code
 * @returns {{ start: number, end: number }[]}
 */
function dictionaryRanges(code) {
  const ranges = [];
  for (const opener of ["const ZH = {", "const EN = {", "panelEnCache = {"]) {
    const at = code.indexOf(opener);
    assert.notEqual(at, -1, "the dictionary " + opener + " is still there");
    // A dictionary ends at a closing brace on its own indentation.
    const end = code.indexOf("\n    };", at);
    assert.notEqual(end, -1, "the dictionary " + opener + " is closed");
    ranges.push({ start: at, end });
  }
  return ranges;
}

const inRanges = (offset, ranges) => ranges.some((range) => offset >= range.start && offset <= range.end);

// ── the dictionary ────────────────────────────────────────────────────────

test("every label the panel draws has an English line", () => {
  const table = dictionary();
  const keys = new Set([...CLIENT.matchAll(/\bT\("((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]));
  assert.ok(keys.size > 300, "the panel draws a few hundred labels, and they are all T()-wrapped");

  const missing = [...keys].filter((key) => typeof table[key] !== "string");
  assert.deepEqual(missing, [], "untranslated labels: an English window would show Chinese for these");
});

test("no English line is a Chinese line", () => {
  for (const [key, value] of Object.entries(dictionary())) {
    assert.ok(value.trim().length > 0, "an empty translation: " + key);
    assert.ok(!CJK.test(value), "still Chinese: " + key + " → " + value);
  }
});

test("a translated line keeps every placeholder its key has", () => {
  const table = dictionary();
  for (const [key, value] of Object.entries(table)) {
    const of = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(of(value), of(key), "placeholders drifted: " + key + " → " + value);
  }
});

// ── the render tree ───────────────────────────────────────────────────────

test("no Chinese literal is left standing in the panel", () => {
  const ranges = dictionaryRanges(CLIENT);
  const bare = [];
  for (const literal of literals(CLIENT)) {
    if (inRanges(literal.start, ranges)) continue;
    if (!CJK.test(literal.text)) continue;
    // A Chinese literal is allowed only as the key of T(...): that is the one
    // place the source text and the lookup key are meant to be the same string.
    const before = CLIENT.slice(Math.max(0, literal.start - 3), literal.start);
    if (/\bT\($/.test(before)) continue;
    // A stylesheet or a markup block is a multi-line literal and its Chinese
    // lives in comments, which a user never sees. A label is always one line, so
    // a single-line literal is the only shape this rule has to police.
    if (literal.text.includes("\n")) {
      assert.match(literal.text, /[{;]/, "a multi-line Chinese literal that is not a stylesheet: " + literal.text.slice(0, 60));
      continue;
    }
    const line = CLIENT.slice(0, literal.start).split("\n").length;
    bare.push("lib/client.js:" + line + " " + literal.text.slice(0, 40));
  }
  assert.deepEqual(bare, [], "these would render as Chinese in an English window");
});

test("the fixed folders and the default workspace follow the reader's language", () => {
  // These rows are named by the host, in Chinese, because that is what they are
  // called there. The panel does not print those names: it looks the label up in
  // FIXED_META, whose label is a getter over T() — a plain string would freeze at
  // whatever language the module happened to load in.
  const table = dictionary();
  for (const entry of Object.values(internals.FIXED_META)) {
    const key = entry.label;
    assert.ok(CJK.test(key), "a fixed entry's label getter returns its Chinese source text");
    assert.ok(typeof table[key] === "string" && table[key].length > 0, "no English line for the fixed folder " + key);
  }
  // The default workspace is not a fixed id: the registry gives it a title of its
  // own, so the node travels with a flag and the panel decides from that.
  assert.equal(table["默认工作区"], "Default workspace");
  assert.match(CLIENT, /if \(node\.fixed && fixed\) return fixed\.label;/);
  assert.match(CLIENT, /if \(node\.default === true\) return T\("默认工作区"\);/);
});

test("no Chinese literal is left standing in the detached window's shim", () => {
  const shim = read("assets/detached/shim.js");
  const bare = [];
  for (const literal of literals(shim)) {
    if (!CJK.test(literal.text)) continue;
    const before = shim.slice(Math.max(0, literal.start - 3), literal.start);
    if (/\bL\($/.test(before)) continue;
    const line = shim.slice(0, literal.start).split("\n").length;
    bare.push("shim.js:" + line + " " + literal.text.slice(0, 40));
  }
  assert.deepEqual(bare, [], "the shim says these before the panel can translate them");
});

test("the window's static page is rewritten, not translated twice", () => {
  const page = read("assets/detached/index.html");
  // The page ships Chinese, because an HTML document is parsed before any script
  // runs; the shim rewrites the title and the boot line for an English window.
  assert.match(page, /<title>[^<]+<\/title>/);
  const shim = read("assets/detached/shim.js");
  assert.match(shim, /document\.title = "Session Explorer"/);
  assert.match(shim, /querySelector\("\.boot-title"\)/);
  assert.match(shim, /note\("Starting…"\)|note\(L\(/);
});
