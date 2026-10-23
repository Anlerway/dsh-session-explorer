/**
 * 日期格式 / 大小单位 — the two display choices in 设置 › 显示.
 *
 * Both formatters are called from rows that never receive a display prop, so the
 * branch they take is decided by one module-level record. That record is what
 * these cases move: they are the only place the four combinations are actually
 * printed, and a wrong branch here would show up for every row at once.
 *
 * @module test/display-format
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: internals } = loadClientBundle({ expose: ["formatSize", "formatRelative", "formatWhen", "panelFormat"] });

/** Move the record the formatters read; every case starts from the defaults. */
function choose(date, size) {
  internals.panelFormat.date = date;
  internals.panelFormat.size = size;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test("自动转换 picks the unit that keeps the number readable", () => {
  choose("date", "auto");
  // An unknown size prints nothing: the row then decides whether to show a dash.
  assert.equal(internals.formatSize(0), "");
  assert.equal(internals.formatSize(-1), "");
  assert.equal(internals.formatSize(Number.NaN), "");
  assert.equal(internals.formatSize(999), "999 B");
  assert.equal(internals.formatSize(1536), "1.5 KB");
  assert.equal(internals.formatSize(19_200_000), "18.3 MB");
  // Past 100 the tenths are noise, so the number is rounded instead.
  assert.equal(internals.formatSize(150 * 1024), "150 KB");
});

test("固定 KB says every size in one unit", () => {
  choose("date", "kb");
  assert.equal(internals.formatSize(1536), "1.5 KB");
  assert.equal(internals.formatSize(19_200_000), "18750 KB");
  // Small files keep a tenth so a 512-byte session log is not "1 KB" and not "0".
  assert.equal(internals.formatSize(512), "0.5 KB");
  assert.equal(internals.formatSize(0), "", "unknown is still unknown, whatever the unit");
});

test("详细日期 prints the clock time, with the year only when it is not this year", () => {
  choose("date", "auto");
  const now = Date.parse("2026-10-23T12:00:00+08:00");
  const thisYear = internals.formatWhen(now - 3 * DAY, now);
  assert.match(thisYear, new RegExp("^\\d{2}-\\d{2} \\d{2}:\\d{2}$"), thisYear);
  const older = internals.formatWhen(Date.parse("2024-03-01T08:30:00+08:00"), now);
  assert.match(older, /^2024-03-01 08:30$/, older);
  assert.equal(internals.formatWhen(0, now), "", "a session with no timestamp prints nothing");
});

test("距今时间 walks the units: 分钟, 小时, 天, 月, 年", () => {
  choose("relative", "auto");
  const now = Date.parse("2026-10-23T12:00:00+08:00");
  // zh-CN RelativeTimeFormat, numeric:auto — the label a person would say, and
  // never a raw count of hours for something a week old.
  assert.match(internals.formatWhen(now - 5 * 60_000, now), /^5\s?分钟前$/, "minutes");
  assert.match(internals.formatWhen(now - 3 * HOUR, now), /^3\s?小时前$/, "hours");
  assert.match(internals.formatWhen(now - 3 * DAY, now), /^3\s?天前$/, "days");
  assert.match(internals.formatWhen(now - 60 * DAY, now), /^2\s?个月前$/, "months");
  assert.match(internals.formatWhen(now - 800 * DAY, now), /^2\s?年前$/, "years");
  // The same instant reads differently under each setting — that is the whole
  // point of the choice, and the reason both formats share one entry point.
  choose("date", "auto");
  assert.match(internals.formatWhen(now - 3 * DAY, now), /^\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("the two choices are independent", () => {
  choose("relative", "kb");
  const now = Date.parse("2026-10-23T12:00:00+08:00");
  assert.match(internals.formatWhen(now - 2 * HOUR, now), /^2\s?小时前$/);
  assert.equal(internals.formatSize(2048), "2.0 KB");
  choose("date", "auto");
});
