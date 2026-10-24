/**
 * The two host helpers behind the 关于 group: the link allowlist and the cache
 * clear.
 *
 * Both are the kind of code that is easy to get wrong in a way nobody notices
 * until it costs a user something — an opener that takes any URL, or a "clean"
 * that takes the quarantine with it — so both are pinned here rather than
 * covered by the page tests, which cannot see the filesystem.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LINK_TARGETS, openInBrowser, openLink } from "../lib/host/open-link.js";
import { clearCaches } from "../lib/host/maintenance.js";
import { REPO_URL } from "../lib/constants.js";

/** A data directory with the leftovers a clear is supposed to take. */
function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "se-about-"));
  mkdirSync(join(dir, ".tmp"), { recursive: true });
  writeFileSync(join(dir, ".tmp", "tree.v1.json.1234.tmp"), "x".repeat(100));
  // A rescued parse failure: cleanTmp parks it in quarantine, it is never
  // deleted — those are the user's own bytes.
  writeFileSync(join(dir, ".tmp", "tree.v1.json.corrupt-99"), "keep me");
  mkdirSync(join(dir, "quarantine"), { recursive: true });
  writeFileSync(join(dir, "quarantine", "tree.v1.json.corrupt-1"), "keep me too");
  writeFileSync(join(dir, "tree.v1.json"), "{}");
  mkdirSync(join(dir, "component", "download"), { recursive: true });
  writeFileSync(join(dir, "component", "download", "electron.zip.part"), "y".repeat(200));
  mkdirSync(join(dir, ".component-staging", "runtime"), { recursive: true });
  writeFileSync(join(dir, ".component-staging", "runtime", "chrome.exe"), "z".repeat(300));
  return dir;
}

/** The slice of the plugin api a clear touches. */
function stubApi(dataDir, phase) {
  const calls = [];
  return {
    calls,
    dataDir,
    paths: { tmpDir: join(dataDir, ".tmp") },
    reader: {
      invalidate: () => calls.push("sessions"),
    },
    documents: {
      tree: { invalidate: () => calls.push("tree") },
      settings: { invalidate: () => calls.push("settings") },
    },
    component: {
      status: async () => ({ phase }),
    },
  };
}

test("the allowlist holds the project's pages and nothing else", () => {
  assert.deepEqual(Object.keys(LINK_TARGETS).sort(), ["issues", "releases", "repo", "star"]);
  assert.equal(LINK_TARGETS.repo, REPO_URL);
  assert.equal(LINK_TARGETS.star, REPO_URL);
  assert.equal(LINK_TARGETS.issues, REPO_URL + "/issues");
  assert.equal(LINK_TARGETS.releases, REPO_URL + "/releases");
});

test("openLink hands an allowlisted target to the opener", async () => {
  const opened = [];
  const result = await openLink("issues", { open: async (url) => opened.push(url) });
  assert.deepEqual(opened, [REPO_URL + "/issues"]);
  assert.deepEqual(result, { target: "issues", url: REPO_URL + "/issues", opened: true });
});

test("openLink refuses a URL, a near-miss and an empty target", async () => {
  const opened = [];
  for (const target of ["https://example.com/", "issue", "", null, "STAR"]) {
    await assert.rejects(
      () => openLink(target, { open: async (url) => opened.push(url) }),
      (error) => error.code === "bad-request",
      "refused: " + String(target),
    );
  }
  assert.deepEqual(opened, [], "nothing was opened");
});

/**
 * A stand-in for a spawned opener.
 *
 * `plan` maps a command name to what that child does: emit an error, exit with
 * a code, or (absent) whatever the last entry says. Every strategy the chain
 * runs is recorded, which is the only way to see the order from out here.
 */
function fakeSpawn(plan) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const listeners = new Map();
    const child = {
      unref() {},
      once(event, fn) {
        const list = listeners.get(event) ?? [];
        list.push(fn);
        listeners.set(event, list);
        return child;
      },
    };
    const step = plan[command] ?? { type: "exit", code: 0 };
    setTimeout(() => {
      const fire = (event, ...payload) => (listeners.get(event) ?? []).forEach((fn) => fn(...payload));
      if (step.type === "error") fire("error", Object.assign(new Error(step.message), { code: step.code ?? "ENOENT" }));
      else fire("exit", step.code ?? 0, null);
    }, 0);
    return child;
  };
  return { calls, spawnImpl };
}

test("the Windows opener reaches for ShellExecute before PowerShell", async () => {
  const { calls, spawnImpl } = fakeSpawn({ "rundll32.exe": { type: "exit", code: 0 } });
  await openInBrowser("https://example.com/x?a=1&b=2", { spawnImpl, platform: "win32" });

  assert.equal(calls.length, 1, "the first strategy worked, so the second never ran");
  assert.equal(calls[0].command, "rundll32.exe");
  // The URL travels as one argument: nothing re-parses it, so `&` stays a query
  // separator instead of becoming a second command.
  assert.deepEqual(calls[0].args, ["url.dll,FileProtocolHandler", "https://example.com/x?a=1&b=2"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
});

test("a failing opener falls through to the next one", async () => {
  const { calls, spawnImpl } = fakeSpawn({ "rundll32.exe": { type: "exit", code: 1 } });
  await openInBrowser(REPO_URL, { spawnImpl, platform: "win32" });
  assert.deepEqual(calls.map((call) => call.command), ["rundll32.exe", "powershell.exe"]);
  // PowerShell gets the quoting it needs for the URL.
  assert.match(calls[1].args.at(-1), /^Start-Process 'https:\/\/github\.com\/Anlerway\/dsh-session-navigator'$/);
});

test("a missing opener binary is not a dead end either", async () => {
  const { calls, spawnImpl } = fakeSpawn({ "rundll32.exe": { type: "error", message: "spawn rundll32.exe ENOENT" } });
  await openInBrowser(REPO_URL, { spawnImpl, platform: "win32" });
  assert.equal(calls.length, 2);
});

test("when every opener fails the error carries the URL the user needs", async () => {
  const { calls, spawnImpl } = fakeSpawn({
    "rundll32.exe": { type: "exit", code: 1 },
    "powershell.exe": { type: "error", message: "spawn powershell.exe ENOENT" },
  });
  await assert.rejects(
    () => openInBrowser(REPO_URL + "/issues", { spawnImpl, platform: "win32" }),
    (error) => {
      assert.equal(error.code, "open-failed");
      // The panel renders this message, so the link itself has to be in it —
      // otherwise a broken jump leaves the user with nothing to paste.
      assert.ok(error.message.includes(REPO_URL + "/issues"), "message names the URL: " + error.message);
      assert.ok(error.message.includes("rundll32.exe"), "message names what was tried: " + error.message);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("off Windows the opener is the platform's own", async () => {
  for (const [platform, expected] of [
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ]) {
    const { calls, spawnImpl } = fakeSpawn({});
    await openInBrowser(REPO_URL, { spawnImpl, platform });
    assert.equal(calls[0].command, expected, platform);
    assert.deepEqual(calls[0].args, [REPO_URL]);
  }
});

test("clearCaches drops the plugin's own caches and keeps the user's bytes", async () => {
  const dir = makeDataDir();
  const api = stubApi(dir, "ready");
  try {
    const result = await clearCaches(api);

    // In memory: the session walk and the sidecars would otherwise answer from
    // memoised copies until the process restarted.
    assert.deepEqual(api.calls, ["sessions", "tree", "settings"]);

    // On disk: the atomic-write leftovers and the unfinished download are gone,
    // the payloads are not.
    assert.equal(existsSync(join(dir, "component", "download", "electron.zip.part")), false);
    assert.equal(existsSync(join(dir, ".component-staging")), false);
    assert.equal(existsSync(join(dir, "tree.v1.json")), true, "the store itself is never touched");
    // cleanTmp rescues an interrupted write into quarantine instead of deleting
    // it, which is why the corrupt payload is still on disk — in its new home,
    // next to the one that was already parked there.
    assert.deepEqual(readdirSync(join(dir, "quarantine")).sort(), [
      "tree.v1.json.corrupt-1",
      "tree.v1.json.corrupt-99",
    ]);

    assert.ok(result.freedBytes >= 600, "the freed bytes are reported, not guessed: " + result.freedBytes);
    assert.equal(result.tmp.removed, 1);
    assert.deepEqual(result.skipped, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a component install in flight keeps its download directory", async () => {
  const dir = makeDataDir();
  const api = stubApi(dir, "downloading");
  try {
    const result = await clearCaches(api);
    assert.deepEqual(result.skipped, ["component-busy"]);
    assert.equal(existsSync(join(dir, "component", "download", "electron.zip.part")), true);
    assert.equal(existsSync(join(dir, ".component-staging")), true);
    // The .tmp sweep is independent of the component and still runs.
    assert.equal(existsSync(join(dir, ".tmp", "tree.v1.json.1234.tmp")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable component record does not become a licence to delete", async () => {
  const dir = makeDataDir();
  const api = stubApi(dir, "ready");
  api.component.status = async () => {
    throw new Error("state file is unreadable");
  };
  try {
    const result = await clearCaches(api);
    // The files may be in use, so the safe direction is to leave them for the
    // next clear rather than delete something a running install is writing.
    assert.deepEqual(result.skipped, ["component-busy"]);
    assert.equal(existsSync(join(dir, "component", "download", "electron.zip.part")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
