/**
 * Tests for the reveal allowlist (L10).
 *
 * `POST /reveal-path` hands a path to DSH's `openWorkspacePath`, which opens it
 * in Explorer/Finder. The client only ever sends the cwd of a session it is
 * showing, so the plugin only accepts paths it already lists — a session's cwd
 * or a workspace's directory. Without that check the route is a general "open
 * any path" primitive reachable from any page in the app, and a UNC path is a
 * credential leak rather than a convenience.
 *
 *   node --test test/reveal.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { knownDirectory } from "../lib/index.js";

/** @param {any} snapshot */
function apiWithSnapshot(snapshot) {
  return { reader: { snapshot: async () => snapshot } };
}

const snapshot = {
  sessions: [{ id: "s1", cwd: join("C:", "work", "alpha") }],
  trashed: [{ id: "s2", cwd: join("C:", "work", "beta") }],
  tree: { nodes: { "w-wa": { type: "workspace", path: join("C:", "work", "gamma") } } },
};

test("a session cwd and a workspace directory may be revealed", async () => {
  const api = apiWithSnapshot(snapshot);
  assert.equal(await knownDirectory(api, join("C:", "work", "alpha")), true);
  assert.equal(await knownDirectory(api, join("C:", "work", "beta")), true);
  assert.equal(await knownDirectory(api, join("C:", "work", "gamma")), true);
});

test("a path the plugin does not list is refused", async () => {
  const api = apiWithSnapshot(snapshot);
  assert.equal(await knownDirectory(api, join("C:", "Windows", "System32")), false);
  assert.equal(await knownDirectory(api, "\\\\host\\share"), false);
  assert.equal(await knownDirectory(api, ""), false);
});

test("a subdirectory of a known path is not the known path", async () => {
  const api = apiWithSnapshot(snapshot);
  assert.equal(await knownDirectory(api, join("C:", "work", "alpha", "src")), false);
});
