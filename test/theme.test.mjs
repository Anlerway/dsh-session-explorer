/**
 * Tests for lib/host/theme.js — the live palette the detached window follows.
 *
 * Two properties matter. The store must hand back exactly the tokens the window
 * can use (no more), and every value must be safe to hand to
 * `style.setProperty`: a theme token arrives over HTTP, and a value that can
 * break out of a declaration or fetch a URL would turn "theme sync" into an
 * injection channel.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createThemeStore, isSafeTokenValue, THEME_TOKENS } from "../lib/host/theme.js";

test("a fresh store has no palette, so the window keeps its fallbacks", () => {
  const store = createThemeStore();
  assert.equal(store.snapshot(), null);
});

test("record keeps only the tokens the stylesheet uses", () => {
  const store = createThemeStore({ now: () => 1234 });
  const recorded = store.record({
    mode: "light",
    tokens: {
      "--dsw-alias-bg-layer-1": "#ffffff",
      "--dsw-alias-label-primary": "#1b1b1c",
      // Not in the allow-list: a scrape of the whole app is not the goal.
      "--dsw-alias-something-private": "#ff0000",
      "--some-other-plugin-token": "red",
    },
  });

  assert.equal(recorded.mode, "light");
  assert.equal(recorded.at, 1234);
  assert.deepEqual(Object.keys(recorded.tokens).sort(), ["--dsw-alias-bg-layer-1", "--dsw-alias-label-primary"]);
  assert.deepEqual(store.snapshot(), recorded);
});

test("mode defaults to dark and only light is recognised", () => {
  const store = createThemeStore();
  assert.equal(store.record({ tokens: {} }).mode, "dark");
  assert.equal(store.record({ mode: "light", tokens: {} }).mode, "light");
  assert.equal(store.record({ mode: "sepia", tokens: {} }).mode, "dark");
});

test("a value that could escape a declaration is refused", () => {
  const bad = [
    "red; background: url(https://evil)",
    "#fff} body{display:none",
    "url(https://evil/x.png)",
    "expression(alert(1))",
    "@import 'x'",
    "javascript:alert(1)",
    "x".repeat(400),
    "",
    "   ",
    42,
    null,
  ];
  for (const value of bad) {
    assert.equal(isSafeTokenValue(value), false, JSON.stringify(value));
  }
});

test("the values DSH actually reports are accepted", () => {
  const good = [
    "#1b1b1c",
    "rgba(255,255,255,.12)",
    "rgb(210 216 222)",
    "color-mix(in oklab, #4176e6 22%, transparent)",
    "oklch(0.62 0.12 250 / 0.9)",
    "var(--dsw-alias-bg-layer-2)",
  ];
  for (const value of good) {
    assert.equal(isSafeTokenValue(value), true, value);
  }
});

test("record drops unsafe values but keeps the rest of the palette", () => {
  const store = createThemeStore();
  const recorded = store.record({
    mode: "light",
    tokens: {
      "--dsw-alias-bg-layer-1": "red;background:url(https://evil)",
      "--dsw-alias-label-primary": "#111111",
    },
  });
  assert.equal(recorded.tokens["--dsw-alias-bg-layer-1"], undefined, "the unsafe value is gone");
  assert.equal(recorded.tokens["--dsw-alias-label-primary"], "#111111");
});

test("clear() forgets the palette", () => {
  const store = createThemeStore();
  store.record({ mode: "light", tokens: { "--dsw-alias-bg-layer-1": "#fff" } });
  store.clear();
  assert.equal(store.snapshot(), null);
});

test("THEME_TOKENS is a fixed, frozen list of CSS custom properties", () => {
  assert.ok(Object.isFrozen(THEME_TOKENS));
  assert.ok(THEME_TOKENS.length >= 8);
  for (const name of THEME_TOKENS) assert.ok(name.startsWith("--dsw-alias-"), name);
  assert.equal(new Set(THEME_TOKENS).size, THEME_TOKENS.length, "no duplicates");
});
