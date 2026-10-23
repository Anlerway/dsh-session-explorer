/**
 * Tests for the two facts a listing reads off a log's two ends.
 *
 *   node --test test/logfacts.test.mjs
 *
 * Both questions are answered from bytes the rest of the plugin never touches:
 * 空白会话 from the first frame (`turn/start` ever seen?) and 已中断 from the last
 * one (is the last event a `turn/end`?). The interesting cases are therefore
 * the two window edges — a log small enough to read whole, a log big enough
 * that only its tail is read, and a tail that starts inside a frame.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

import { clearLogFacts, readLogFacts } from "../lib/sources/logfacts.js";

/** @returns {Promise<string>} */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), "se-logfacts-"));
}

/**
 * Write a log made of one zstd frame per batch.
 *
 * @param {string} path
 * @param {string[][]} batches event lines per frame
 * @returns {Promise<number>} bytes written
 */
async function writeLog(path, batches) {
  const frames = batches.map((lines) => zstdCompressSync(Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8")));
  const buf = Buffer.concat(frames);
  await writeFile(path, buf);
  return buf.length;
}

const header = '{"type":"session/header","id":"s-1","formatVersion":4}';
const turnStart = '{"type":"turn/start","turnId":"t-1"}';
const turnEnd = '{"type":"turn/end","turnId":"t-1","reason":"completed"}';
const message = '{"type":"message/part","text":"hi"}';

test("a log whose last event is turn/end is finished", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header, turnStart, message], [turnEnd]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.deepEqual(facts, { turnStart: true, lastType: "turn/end", torn: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a log that never started a turn is blank", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.equal(facts.turnStart, false);
    assert.equal(facts.lastType, "session/header");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a log cut off mid-turn ends on turn/start", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    // The last thing written was the turn opening; its turn/end never arrived.
    const size = await writeLog(path, [[header, message], [turnStart]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.equal(facts.turnStart, true);
    assert.equal(facts.lastType, "turn/start");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cut can also end on an ordinary event, which is still 已中断", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    // A crash mid-answer leaves the last *event* written, not a turn/start.
    const size = await writeLog(path, [[header, turnStart], [message]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.equal(facts.turnStart, true);
    assert.equal(facts.lastType, "message/part");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a large log is classified from its tail window, not read whole", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    // Base64 of random bytes does not compress, so the file really is hundreds
    // of KB and the small-file path is not what gets exercised.
    const noisy = () => `{"type":"message/part","text":"${randomBytes(96).toString("base64")}"}`;
    const batches = [[header, turnStart]];
    for (let index = 0; index < 120; index += 1) {
      batches.push(Array.from({ length: 30 }, noisy));
    }
    batches.push([turnEnd]);
    const size = await writeLog(path, batches);
    assert.ok(size > 256 * 1024, `fixture must exceed the small-log bound, got ${size}`);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.equal(facts.turnStart, true);
    assert.equal(facts.lastType, "turn/end");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn tail keeps the last complete frame's answer", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header, turnStart], [turnEnd]]);
    // Half a frame appended by a write that was interrupted.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, zstdCompressSync(Buffer.from(`${message}\n`)).subarray(0, 6));
    clearLogFacts();
    const facts = await readLogFacts(path, size + 6, 1);
    assert.equal(facts.torn, true);
    assert.equal(facts.lastType, "turn/end");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("facts are cached by path+size+mtime, so a listing does not re-read", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header, turnStart]]);
    clearLogFacts();
    const first = await readLogFacts(path, size, 1);
    assert.equal(first.lastType, "turn/start");
    // Delete the file: a second read that went to disk would return null.
    await rm(path);
    const second = await readLogFacts(path, size, 1);
    assert.deepEqual(second, first);
    // A different mtime is a different key — the log may have grown.
    const third = await readLogFacts(path, size, 2);
    assert.equal(third, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable log yields null instead of failing the listing", async () => {
  clearLogFacts();
  assert.equal(await readLogFacts(join(tmpdir(), "se-does-not-exist", "x.zstd"), 10, 1), null);
  assert.equal(await readLogFacts(null), null);
});
