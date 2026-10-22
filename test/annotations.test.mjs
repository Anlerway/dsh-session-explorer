/**
 * Tests for the annotation id guard (L4).
 *
 * The annotation document is keyed by session id. `__proto__` as a key writes
 * the object's prototype instead of an entry, so a patch silently disappeared
 * while the route reported success; `constructor` and `prototype` are the same
 * hole spelled differently. Any other string used to mint a phantom entry that
 * no session would ever read.
 *
 *   node --test test/annotations.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isAnnotationId, patchAnnotation } from "../lib/domain/annotations.js";

test("an id that is not a session id cannot become an annotation key", () => {
  for (const id of ["__proto__", "constructor", "prototype", "", "  ", "a b", "a/b"]) {
    assert.equal(isAnnotationId(id), false, `${JSON.stringify(id)} must be refused`);
  }
  assert.equal(isAnnotationId("session-c312bb10-0f03-4d1c-a6f3-140f7725d4ab"), true);
  assert.equal(isAnnotationId("agent-7"), true);
});

test("a prototype key leaves the document untouched instead of writing through it", () => {
  /** @type {any} */
  const document = { sessions: {} };
  assert.equal(patchAnnotation(document, "__proto__", { favorite: true }), null);
  assert.equal(/** @type {any} */ (Object.prototype).favorite, undefined);
  assert.equal(Object.keys(document.sessions).length, 0);
});
