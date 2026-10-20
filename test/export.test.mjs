/**
 * Tests for lib/domain/export.js — turning a session log into Markdown/JSONL.
 *
 * The two things worth pinning are the ones that are easy to get subtly wrong:
 * surface operations (compaction must not leak the pre-compaction transcript)
 * and content blocks (a tool call belongs to its turn, not to a message of its
 * own).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { blocksOf, exportFileName, maskedSeqs, toJsonl, toMarkdown, turnsOf } from "../lib/domain/export.js";

/** A tiny but realistic event stream. */
function artifact(extra = []) {
  return {
    header: { id: "sess-1", title: "重构插件", cwd: "C:/work", createdAt: 1_700_000_000_000 },
    events: [
      { seq: 0, type: "session/start", data: {} },
      { seq: 1, type: "user/message", at: 1_700_000_001_000, data: { content: [{ type: "text", text: "先看排序" }] } },
      {
        seq: 2,
        type: "assistant/message",
        at: 1_700_000_002_000,
        data: {
          content: [
            { type: "reasoning", text: "先读代码" },
            { type: "text", text: "好的。" },
            { type: "tool-call", name: "read", arguments: { path: "a.js" } },
          ],
        },
      },
      ...extra,
    ],
  };
}

test("turnsOf keeps only the two chat message types, in order", () => {
  const turns = turnsOf(artifact().events);
  assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant"]);
  assert.equal(turns[0].text, "先看排序");
  assert.equal(turns[1].text, "好的。");
  assert.equal(turns[1].reasoning, "先读代码");
  assert.equal(turns[1].tools.length, 1);
});

test("blocksOf tolerates a plain string and unknown block types", () => {
  assert.deepEqual(blocksOf("hello"), { text: "hello", reasoning: "", tools: [] });
  assert.deepEqual(blocksOf([{ type: "mystery", text: "x" }]), { text: "", reasoning: "", tools: [] });
  assert.deepEqual(blocksOf(null), { text: "", reasoning: "", tools: [] });
});

test("a surface replace hides the events it masks", () => {
  const events = [
    ...artifact().events,
    // Compaction: everything up to seq 2 is replaced by a summary at seq 3.
    { seq: 3, type: "session/compaction", data: {} },
    { seq: 4, type: "surface/replace", surfaceOp: { kind: "replace", ranges: [{ from: 1, to: 2 }] } },
    { seq: 5, type: "assistant/message", at: 1_700_000_003_000, data: { content: [{ type: "text", text: "（摘要）之前的对话已压缩" }] } },
  ];
  const hidden = maskedSeqs(events);
  assert.deepEqual([...hidden].sort((a, b) => a - b), [1, 2]);

  const turns = turnsOf(events);
  assert.deepEqual(turns.map((turn) => turn.text), ["（摘要）之前的对话已压缩"]);
});

test("a later replace does not resurrect an earlier masked range", () => {
  const events = [
    ...artifact().events,
    { seq: 4, type: "surface/replace", surfaceOp: { kind: "replace", ranges: [{ from: 1, to: 1 }] } },
    { seq: 6, type: "surface/replace", surfaceOp: { kind: "replace", ranges: [{ from: 2, to: 2 }] } },
  ];
  const hidden = maskedSeqs(events);
  assert.ok(hidden.has(1), "the first range stays masked");
  assert.ok(hidden.has(2), "the second is masked too");
  assert.equal(turnsOf(events).length, 0, "no chat turn survives");
});

test("a hide op masks the seqs it names", () => {
  const events = [...artifact().events, { seq: 9, type: "surface/hide", surfaceOp: { kind: "hide", seqs: [2] } }];
  assert.deepEqual(turnsOf(events).map((turn) => turn.role), ["user"]);
});

test("Markdown renders a title, per-turn headings and tool details", () => {
  const markdown = toMarkdown(artifact(), { includeTools: true });
  assert.ok(markdown.startsWith("# 重构插件"), "title is the heading");
  assert.ok(markdown.includes("会话 id：`sess-1`"), "facts are listed");
  assert.ok(markdown.includes("## 用户"), "user turn heading");
  assert.ok(markdown.includes("## 助手"), "assistant turn heading");
  assert.ok(markdown.includes("先看排序"));
  assert.ok(markdown.includes("<details><summary>工具调用 · read</summary>"), "tool call folded into the turn");
  assert.ok(!markdown.includes("先读代码"), "reasoning is opt-in");
});

test("Markdown can include reasoning and omit tools", () => {
  const markdown = toMarkdown(artifact(), { includeTools: false, includeReasoning: true });
  assert.ok(markdown.includes("> 思考"), "reasoning rendered as a quote");
  assert.ok(markdown.includes("先读代码"));
  assert.ok(!markdown.includes("工具调用"), "tools omitted");
});

test("JSONL is one turn per line plus a session header", () => {
  const lines = toJsonl(artifact()).trim().split("\n");
  assert.equal(lines.length, 3, "header + two turns");
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, "session");
  assert.equal(header.id, "sess-1");
  assert.equal(header.turns, 2);
  assert.equal(JSON.parse(lines[1]).role, "user");
  assert.equal(JSON.parse(lines[2]).role, "assistant");
});

test("an empty session still exports a valid document", () => {
  const empty = { header: { id: "x" }, events: [] };
  assert.ok(toMarkdown(empty, {}).includes("# x"));
  assert.equal(toJsonl(empty).trim().split("\n").length, 1, "header only");
});

test("exportFileName strips characters a filesystem refuses", () => {
  // The character run collapses to one dash, so the name stays readable.
  assert.equal(exportFileName({ id: "x" }, 'a/b:c*?"<>|d', "md"), "a-b-c-d.md");
  assert.equal(exportFileName({ id: "x" }, "", "jsonl"), "x.jsonl");
  assert.equal(exportFileName({ id: "x" }, "  spaced  name  ", "md"), "spaced name.md");
});
