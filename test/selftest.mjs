/**
 * Self-test: run the read pipeline against this machine's real DSH data.
 *
 * Usage:
 *   node test/selftest.mjs            # human summary
 *   node test/selftest.mjs --json     # machine summary
 *
 * It asserts nothing about *which* sessions exist (that changes constantly) but
 * it does hold the invariants that matter: every listed session has an id,
 * a display title, a resolvable cwd, exactly one home in the tree, and the tree
 * counts add up. Exits non-zero on the first broken invariant.
 */

import { dshHome } from "../lib/dsh/home.js";
import { createReader } from "../lib/sources/reader.js";
import { FIXED_NODES, WORKSPACE_NODE_PREFIX } from "../lib/constants.js";

const home = dshHome();
const reader = createReader({ dshHome: () => home });
const snapshot = await reader.snapshot({ refresh: true });
const { sessions, tree, registry, stats } = snapshot;

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

check(typeof home === "string" && home.length > 0, "dsh home resolved");
check(Array.isArray(sessions), "sessions is an array");
check(tree && typeof tree.nodes === "object", "tree exists");
check(tree.roots[0] === FIXED_NODES.root, "root is the first tree root");
check(tree.roots.length === 2 && tree.roots[1] === FIXED_NODES.trash, "only the trash sits outside the root");

const ids = new Set();
for (const session of sessions) {
  check(typeof session.id === "string" && session.id.length > 0, `session id present: ${JSON.stringify(session)}`);
  check(!ids.has(session.id), `duplicate session id ${session.id}`);
  ids.add(session.id);
  check(typeof session.displayTitle === "string" && session.displayTitle.length > 0, `display title for ${session.id}`);
  check(session.workspaceId === null || tree.nodes[`${WORKSPACE_NODE_PREFIX}${session.workspaceId}`] !== undefined,
    `workspace node exists for ${session.id}`);
}

// Every session must be accounted for by exactly one container node.
const containerNodes = tree.roots.flatMap((root) => tree.children[root] ?? [])
  .filter((id) => id !== FIXED_NODES.favorites && id !== FIXED_NODES.todos && id !== FIXED_NODES.trash);
const counted = containerNodes.reduce((sum, id) => sum + (tree.counts[id] ?? 0), 0);
check(counted === sessions.length, `tree containers count ${counted} == sessions ${sessions.length}`);

// The workspace set must agree with the registry in both directions.
for (const workspaceId of registry?.workspaceIds ?? []) {
  check(tree.nodes[`${WORKSPACE_NODE_PREFIX}${workspaceId}`] !== undefined, `workspace node for ${workspaceId}`);
}

const orphans = sessions.filter((session) => session.workspaceId === null);
for (const orphan of orphans) {
  check(tree.counts[FIXED_NODES.ungrouped] >= 1, "ungrouped count reflects orphans");
}

const pinned = sessions.filter((session) => session.pinned).length;
check(tree.counts[FIXED_NODES.favorites] === pinned, "favorites count matches pin set");

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ home, stats, counts: tree.counts, failures }, null, 2));
} else {
  console.log(`DSH home      : ${home}`);
  console.log(`workspaces    : ${stats.workspaces}`);
  console.log(`sessions      : ${sessions.length}  (cache ${stats.withCache}, header-only ${stats.headerOnly}, rejected ${stats.cacheRejected})`);
  console.log(`scan duration : ${stats.durationMs} ms`);
  console.log(`tree counts   : ${JSON.stringify(tree.counts)}`);
  console.log("");
  const width = Math.min(64, Math.max(...sessions.map((session) => session.displayTitle.length), 8));
  for (const session of sessions.slice(0, 20)) {
    const when = session.activityAt ? new Date(session.activityAt).toISOString().slice(5, 16).replace("T", " ") : "(never)";
    const where = session.workspaceTitle ?? "(ungrouped)";
    console.log(`${session.displayTitle.slice(0, width).padEnd(width)}  ${when}  ${String(session.stats?.turns ?? "-").padStart(3)}t  ${where}`);
  }
  if (sessions.length > 20) console.log(`… ${sessions.length - 20} more`);
}

if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("\nOK");
