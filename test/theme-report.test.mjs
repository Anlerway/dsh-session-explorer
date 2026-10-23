/**
 * What the panel reports, not just what the Host stores.
 *
 * The detached window paints itself from `/theme`, so two things have to hold on
 * the *reporting* side, and both did not:
 *
 * 1. DSH declares its palette on `body`, not on `<html>`, and `apply()` reports
 *    before the panel is mounted — so reading `documentElement` (or the shell
 *    that does not exist yet) yields nothing, the Host stores an empty palette,
 *    and the window keeps its hard-coded fallback accent.
 *
 * 2. `--dsw-alias-*` values are *references* into DSH's own palette
 *    (`--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50)`). The
 *    window has no `--dsw-static-*` stylesheet, so a verbatim copy resolves to
 *    nothing there — and a property that resolves to nothing is invalid, which
 *    a `var(--token, fallback)` consumer cannot fall back from.
 *
 * test/theme.test.mjs pins the Host's filtering; this file pins the panel's
 * reading and resolution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

/** A computed style that answers from a plain map, like a themed document. */
function styled(map) {
  return {
    getPropertyValue: (name) => (Object.hasOwn(map, name) ? map[name] : ""),
  };
}

/**
 * Load the bundle against one document surface.
 *
 * @param {{ shell?: Record<string, string>|null, body?: Record<string, string>, root?: Record<string, string> }} surfaces
 */
function load(surfaces) {
  const fetch = recordingFetch();
  const shell = surfaces.shell === null ? null : { style: {} };
  const document = {
    querySelector: (selector) => (selector === ".se-shell" ? shell : null),
    body: {},
    documentElement: { getAttribute: () => null },
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
    head: { appendChild: () => {} },
    getElementById: () => null,
    createTextNode: () => ({}),
  };
  const styles = new Map([
    [document.body, styled(surfaces.body ?? {})],
    [document.documentElement, styled(surfaces.root ?? {})],
  ]);
  if (shell) styles.set(shell, styled(surfaces.shell ?? surfaces.body ?? {}));
  globalThis.getComputedStyle = (element) => styles.get(element) ?? styled({});
  const loaded = loadClientBundle({ document, fetch, expose: ["reportTheme", "resolveThemeValue"] });
  return { ...loaded, fetch };
}

/** The tokens of the single /theme POST the panel just made. */
function reported(fetch) {
  const posts = fetch.calls.filter((call) => call.method === "POST" && call.url.endsWith("/theme"));
  assert.equal(posts.length, 1, "the panel reports exactly once");
  return posts[0].body;
}

test("references into DSH's palette are resolved before they are shipped", async () => {
  const { test: surface, fetch } = load({
    shell: {
      "--dsw-alias-label-primary": "var(--dsw-static-neutral-bluish-50)",
      "--dsw-static-neutral-bluish-50": "#f5f6f7",
      "--dsw-alias-bg-layer-1": "var(--dsw-static-neutral-bluish-900)",
      "--dsw-static-neutral-bluish-900": "rgb(38, 38, 39)",
    },
  });
  await surface.reportTheme();
  assert.deepEqual(reported(fetch), {
    mode: "dark",
    tokens: {
      "--dsw-alias-label-primary": "#f5f6f7",
      "--dsw-alias-bg-layer-1": "rgb(38, 38, 39)",
    },
  });
});

test("a token that cannot be resolved is dropped, not shipped as a dud", async () => {
  const { test: surface, fetch } = load({
    shell: {
      "--dsw-alias-state-business-primary": "var(--dsw-brand-accent)",
      "--dsw-alias-label-primary": "var(--dsw-static-neutral-bluish-50)",
      "--dsw-static-neutral-bluish-50": "#f5f6f7",
    },
  });
  await surface.reportTheme();
  assert.deepEqual(Object.keys(reported(fetch).tokens), ["--dsw-alias-label-primary"]);
});

test("a reference's own fallback stands in when the palette lacks it", async () => {
  const { test: surface } = load({ shell: {} });
  assert.equal(surface.resolveThemeValue(styled({}), "var(--missing, #123456)"), "#123456");
  assert.equal(surface.resolveThemeValue(styled({}), "var(--missing)"), "");
  assert.equal(surface.resolveThemeValue(styled({}), "#abcdef"), "#abcdef");
});

test("a self-referential palette cannot spin", async () => {
  const { test: surface } = load({ shell: {} });
  const looping = styled({ "--a": "var(--a)" });
  assert.equal(surface.resolveThemeValue(looping, "var(--a)"), "");
});

test("before the shell mounts the body palette is read, not the empty root", async () => {
  // DSH keeps its palette on <body>: <html> answers nothing, and that is where
  // the pre-mount report used to read from.
  const { test: surface, fetch } = load({
    shell: null,
    body: { "--dsw-alias-label-primary": "#f5f6f7" },
    root: {},
  });
  await surface.reportTheme();
  assert.deepEqual(reported(fetch).tokens, { "--dsw-alias-label-primary": "#f5f6f7" });
});

test("the panel reports again once its shell exists", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const panel = source.slice(source.indexOf("function Panel({ t })"));
  assert.match(
    panel.slice(0, 2000),
    /useEffect\(\(\) => \{\n\s+reportTheme\(\);\n\s+\}, \[\]\);/,
    "Panel re-reports the palette on mount",
  );
});
