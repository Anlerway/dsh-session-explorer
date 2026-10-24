/**
 * "Is there a newer release?" — the parsing, the ordering and the one request.
 *
 * Everything here is injected: `fetch` is a parameter, so the suite never talks
 * to GitHub and never spends a rate-limit token on a CI run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  checkUpdate,
  compareVersions,
  parseRelease,
  pluginVersion,
  resetUpdateCache,
} from "../lib/host/update.js";
import { REPO_URL } from "../lib/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

/** A fetch that answers once with the given status/body and counts calls. */
function stubFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (body === undefined) throw new Error("not json");
        return body;
      },
    };
  };
  return { fetchImpl, calls };
}

test.beforeEach(() => {
  resetUpdateCache();
});

test("pluginVersion is the version in package.json, not a second copy", () => {
  assert.equal(pluginVersion(), pkg.version);
});

test("compareVersions orders releases the way a human reads them", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0, "a leading v is presentation, not semantics");
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareVersions("0.9.9", "1.0.0"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "numeric, not lexicographic");
  assert.equal(compareVersions("1.0", "1.0.0"), 0, "a missing segment is a zero");
  // A prerelease sorts before the release it leads to: an rc must not be
  // advertised as newer than the release the user already runs.
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
});

test("parseRelease keeps what the rows show and trims the notes", () => {
  const release = parseRelease({
    tag_name: "v2.0.0",
    html_url: "https://github.com/Anlerway/dsh-session-explorer/releases/tag/v2.0.0",
    name: "2.0.0",
    published_at: "2026-10-20T10:00:00Z",
    body: "x".repeat(5000),
  });
  assert.equal(release.latest, "2.0.0", "the tag is shown without its v");
  assert.equal(release.name, "2.0.0");
  assert.equal(release.publishedAt, "2026-10-20T10:00:00Z");
  assert.equal(release.notes.length, 2000);

  // An empty answer is not an exception: it is "nothing to compare".
  const empty = parseRelease({});
  assert.equal(empty.latest, null);
  assert.equal(empty.url, REPO_URL + "/releases");
});

test("a newer release turns hasUpdate on, and is answered from the cache next time", async () => {
  const { fetchImpl, calls } = stubFetch(200, { tag_name: "v1.2.0", html_url: REPO_URL + "/releases/tag/v1.2.0" });
  const first = await checkUpdate({ fetchImpl });
  assert.equal(first.current, pkg.version);
  assert.equal(first.latest, "1.2.0");
  assert.equal(first.hasUpdate, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/Anlerway/dsh-session-explorer/releases/latest");
  assert.match(calls[0].init.headers["user-agent"], /^dsh-session-navigator\//);

  // Second press inside the TTL: no second request.
  await checkUpdate({ fetchImpl });
  assert.equal(calls.length, 1);

  // ...unless it is forced.
  await checkUpdate({ fetchImpl, force: true });
  assert.equal(calls.length, 2);
});

test("the running version, or an older one, is not an update", async () => {
  const same = await checkUpdate({ fetchImpl: stubFetch(200, { tag_name: "v" + pkg.version }).fetchImpl });
  assert.equal(same.hasUpdate, false);

  resetUpdateCache();
  const older = await checkUpdate({ fetchImpl: stubFetch(200, { tag_name: "v0.0.1" }).fetchImpl });
  assert.equal(older.hasUpdate, false);
});

test("a repository with no releases yet is not an error", async () => {
  const { fetchImpl } = stubFetch(404, { message: "Not Found" });
  const result = await checkUpdate({ fetchImpl });
  assert.equal(result.latest, null);
  assert.equal(result.hasUpdate, false);
  assert.equal(result.url, REPO_URL + "/releases");
});

test("unreachable, refused and malformed answers are reported as failures", async () => {
  await assert.rejects(
    () => checkUpdate({ fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } }),
    (error) => error.code === "update-unreachable" && /cannot reach GitHub/.test(error.message),
  );

  resetUpdateCache();
  await assert.rejects(
    () => checkUpdate({ fetchImpl: stubFetch(500, { message: "boom" }).fetchImpl }),
    (error) => error.code === "update-unreachable" && /HTTP 500/.test(error.message),
  );

  resetUpdateCache();
  await assert.rejects(
    () => checkUpdate({ fetchImpl: stubFetch(200, undefined).fetchImpl }),
    (error) => error.code === "update-unreachable" && /not JSON/.test(error.message),
  );
});
