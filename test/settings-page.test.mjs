/**
 * The settings page's 打开方式 group, rendered for real.
 *
 * The page is the only place 默认打开方式 can be changed, and it mounts outside
 * the panel, so neither `render-smoke.mjs` (which never runs effects) nor a
 * domain test can see it: the page holds its document in state that arrives from
 * `GET /settings` *after* the first render.
 *
 * The driver below is a tiny stateful React — hooks keep their values between
 * passes and effects run once per component — because "the chip I clicked saved
 * the mode" is exactly the class of bug that reads fine in the source and breaks
 * in the window.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

const EXPOSE = ["SettingsSection"];

/**
 * A React stand-in with working state.
 *
 * Hook storage is keyed by the component's position in the rendered tree, not by
 * a global call counter: a child that mounts on a later pass (`ComponentGroup`,
 * which waits for the document) must not inherit its parent's hook slots.
 */
function makeReact() {
  const scopes = new Map();
  const ranEffects = new Set();
  let cursor = 0;
  let cells = [];
  let pending = [];
  let dirty = false;

  const hook = (index, create) => {
    if (!(index in cells)) cells[index] = create();
    return cells[index];
  };
  const readIndex = () => cursor++;

  const React = {
    Component: class {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
      setState(patch) {
        this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
        dirty = true;
      }
    },
    Fragment: Symbol("Fragment"),
    createElement: (type, props, ...children) => {
      const merged = { ...(props ?? {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged, children };
    },
    createPortal: (node) => node,
    useRef: (initial) => hook(readIndex(), () => ({ current: initial })),
    useState: (initial) => {
      const cell = hook(readIndex(), () => ({ value: typeof initial === "function" ? initial() : initial }));
      const set = (next) => {
        const value = typeof next === "function" ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        dirty = true;
      };
      return [cell.value, set];
    },
    useEffect: (effect) => {
      const index = readIndex();
      // Once per component, like `[]` deps — the one effect in this page that
      // would loop is the one guarded by a `[]` dependency list.
      if (ranEffects.has(cells.scope + ":" + index)) return;
      ranEffects.add(cells.scope + ":" + index);
      pending.push(effect);
    },
    useLayoutEffect: (effect) => React.useEffect(effect),
    useMemo: (compute) => compute(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };

  /** Render one pass, running each first-time effect. */
  async function settle(renderRoot) {
    for (let pass = 0; pass < 25; pass += 1) {
      pending = [];
      dirty = false;
      const tree = renderRoot();
      for (const effect of pending) {
        try {
          effect();
        } catch (error) {
          throw new Error("an effect threw: " + error?.message);
        }
      }
      // Let every awaited request land before deciding whether to paint again.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!dirty) return tree;
    }
    throw new Error("the settings page did not settle");
  }

  /** Walk the tree, calling components; host elements keep their props. */
  function render(element, path = "root") {
    if (element === null || element === undefined || typeof element !== "object") return element;
    if (Array.isArray(element)) return element.map((child, index) => render(child, `${path}[${index}]`));
    if (typeof element.type === "function") {
      const savedCursor = cursor;
      const savedCells = cells;
      cells = scopes.get(path) ?? [];
      cells.scope = path;
      scopes.set(path, cells);
      cursor = 0;
      let output;
      if (element.type.prototype && typeof element.type.prototype.render === "function") {
        output = new element.type(element.props).render();
      } else {
        output = element.type(element.props, ...(element.children ?? []));
      }
      cursor = savedCursor;
      cells = savedCells;
      return render(output, `${path}>`);
    }
    return {
      type: element.type,
      props: element.props,
      children: (element.children ?? []).map((child, index) => render(child, `${path}/${index}`)),
    };
  }

  return { React, settle, render };
}

/** Every host element in a rendered tree that matches a predicate. */
function collect(element, match, out = []) {
  if (!element || typeof element !== "object") return out;
  if (Array.isArray(element)) {
    for (const child of element) collect(child, match, out);
    return out;
  }
  if (match(element)) out.push(element);
  for (const child of element.children ?? []) collect(child, match, out);
  return out;
}

/** An element's text, including nested text. */
function textOf(element) {
  if (element === null || element === undefined) return "";
  if (typeof element === "string" || typeof element === "number") return String(element);
  if (Array.isArray(element)) return element.map(textOf).join("");
  return (element.children ?? []).map(textOf).join("");
}

const byClass = (name) => (element) => {
  const className = typeof element.props?.className === "string" ? element.props.className : "";
  return className.split(/\s+/).includes(name);
};

/** The settings document the host would answer with. */
function settingsDocument(mode, component) {
  return {
    settings: {
      shell: {
        open: { mode },
        modal: { sizing: "fixed", size: "md", percent: "p70", dim: 0, closeOnBackdrop: true },
        window: { alwaysOnTop: false, bounds: null },
        header: { style: "auto" },
      },
      list: { autoCollapse: false, showArchived: true },
      dataDir: { current: null },
    },
    revision: 4,
    capabilities: { component },
    dataDir: "C:/data",
    // The build number rides along with the document so the 关于 group can print
    // it without a request of its own.
    version: "1.0.0",
  };
}

/** One render of the page, through the driver so its hooks get a stable scope. */
const page = (driver, api, t) => driver.render(driver.React.createElement(api.SettingsSection, { t }));

/** The real `t` replaces `{name}` placeholders. Tests usually match on the bare
 *  key, so interpolation is opt-in — but a case that asserts on a number needs it,
 *  and the key is kept in front of the text so both assertions still work. */
const interpolating = (key, vars = {}) =>
  key.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole)) +
  (Object.keys(vars).length ? `(${Object.values(vars).join(", ")})` : "");

/** Render the page against a document, and hand back the tree and the calls. */
async function renderSettings({ mode = "panel", component = "absent", update = null, clear = null, interpolate = false } = {}) {
  const fetchImpl = recordingFetch((call) => {
    const path = call.url.replace(/^.*?\/api/, "");
    if (path === "/settings" && call.method === "GET") {
      return { ok: true, result: settingsDocument(mode, component) };
    }
    if (path === "/settings" && call.method === "PUT") {
      // The stub answers with the document a real host would now hold: the
      // patch applied, so a re-render shows the saved value.
      const doc = settingsDocument(call.body.shell?.open?.mode ?? mode, component);
      if (call.body.shell?.header) doc.settings.shell.header = call.body.shell.header;
      if (call.body.list) Object.assign(doc.settings.list, call.body.list);
      return { ok: true, result: { settings: doc.settings, revision: 5 } };
    }
    // The component group re-probes on mount and reports the phase upward, so
    // the launch chips have to agree with it — a stub that answered nothing
    // would leave 独立弹窗 disabled however the document was written.
    if (path === "/component/status") {
      return { ok: true, result: { phase: component, version: "1.0.0", installed: component === "ready" } };
    }
    // 关于: the update check, the cache clear and the link opener are the only
    // routes on this page that do something irreversible-ish, so the stub
    // answers each one explicitly instead of with a bare {}.
    if (path.startsWith("/update")) {
      return update
        ? { ok: true, result: update }
        : { ok: false, code: "update-unreachable", error: "GitHub is not reachable" };
    }
    if (path === "/cache/clear") {
      return {
        ok: true,
        result: clear ?? { freedBytes: 0, caches: [], tmp: { removed: 0, bytes: 0 }, downloads: { removed: 0, bytes: 0 }, staging: { removed: 0, bytes: 0 }, skipped: [], tookMs: 1 },
      };
    }
    if (path === "/about/open") {
      return { ok: true, result: { target: call.body?.target ?? "", url: "", opened: true } };
    }
    // 清除数据: the stub answers with the summary a real host returns, so the
    // page's "freed N" line has something to print.
    if (path === "/data/reset") {
      return {
        ok: true,
        result: {
          freedBytes: 2048,
          documents: { tree: { removed: true, bytes: 1024 }, settings: { removed: true, bytes: 1024 } },
          trash: { removed: 2, bytes: 0 },
          quarantine: { removed: 0, bytes: 0 },
          tmp: { removed: 0, bytes: 0 },
          keptLocation: null,
          dataDir: "C:/data",
          tookMs: 3,
        },
      };
    }
    return { ok: true, result: {} };
  });
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key, vars) => (interpolate ? interpolating(key, vars) : key);
  const tree = await driver.settle(() => page(driver, api, t));
  return { tree, calls: fetchImpl.calls, driver, api, t };
}

test("打开方式 is the first group on the page, with 浮窗 selected", async () => {
  const { tree } = await renderSettings({ mode: "panel", component: "absent" });
  const groups = collect(tree, byClass("se-set-grp"));
  assert.ok(groups.length >= 3, "the page renders its groups");
  // The launch mode is the question the user has every time they press the
  // entry, so it sits above 列表 / 浮窗 / 浏览器组件.
  assert.match(textOf(groups[0]), /setGroupOpen/);

  const chips = collect(tree, byClass("se-set-chip"));
  const labels = chips.map(textOf);
  assert.deepEqual(labels.slice(0, 2), ["setOpenPanel", "setOpenDetached"]);
  assert.match(chips[0].props.className, /\bon\b/, "浮窗 is the selected chip");
  assert.doesNotMatch(chips[1].props.className, /\bon\b/);
  // Without the browser component the window cannot open, so the chip says so
  // instead of accepting a value the launch would have to walk back.
  assert.equal(chips[1].props.disabled, true);
  assert.equal(chips[1].props.title, "setOpenDetachedBlocked");
});

test("picking 独立弹窗 saves the mode and nothing else", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ mode: "panel", component: "ready" });
  const chips = collect(tree, byClass("se-set-chip"));
  assert.equal(chips[1].props.disabled, false, "a ready component enables the window");

  chips[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.ok(write, "the click writes immediately — there is no OK button");
  // A partial patch: the modal group must not be rewritten from the page's copy.
  assert.deepEqual(write.body, { shell: { open: { mode: "detached" } } });
  assert.equal(write.headers["if-match"], '"4"', "the write cites the revision it read");

  // The page then renders the saved value, so the chip is visibly the chosen one.
  const after = await driver.settle(() => page(driver, api, t));
  const chipsAfter = collect(after, byClass("se-set-chip"));
  assert.match(chipsAfter[1].props.className, /\bon\b/);
});

test("a document written before the setting existed shows 浮窗, not an empty group", async () => {
  const fetchImpl = recordingFetch(() => ({ ok: true, result: settingsDocument(undefined, "absent") }));
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key) => key;
  const tree = await driver.settle(() => page(driver, api, t));
  const chips = collect(tree, byClass("se-set-chip"));
  assert.match(chips[0].props.className, /\bon\b/);
});

test("会话界面 offers 自动 and 仅显示图标, and saves the pick alone", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ mode: "panel", component: "absent" });
  const groups = collect(tree, byClass("se-set-grp"));
  const header = groups.find((group) => textOf(group).includes("setGroupHeader"));
  assert.ok(header, "the group is on the page");

  const chips = collect(header, byClass("se-set-chip"));
  assert.deepEqual(chips.map(textOf), ["setHeaderAuto", "setHeaderIcon"]);
  assert.match(chips[0].props.className, /\bon\b/, "自动 is the default");

  chips[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.ok(write, "the click writes immediately");
  // A patch of exactly this key: the launch mode and the modal group are not
  // echoed back from a page that may have been open for a while.
  assert.deepEqual(write.body, { shell: { header: { style: "icon" } } });

  const after = await driver.settle(() => page(driver, api, t));
  const afterHeader = collect(after, byClass("se-set-grp")).find((group) =>
    textOf(group).includes("setGroupHeader"),
  );
  const afterChips = collect(afterHeader, byClass("se-set-chip"));
  assert.match(afterChips[1].props.className, /\bon\b/, "仅显示图标 is now the chosen chip");
});

test("显示 offers 详细日期 / 距今时间 and 自动转换 / 固定 KB, each saved alone", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ mode: "panel", component: "absent" });
  const groups = collect(tree, byClass("se-set-grp"));
  const display = groups.find((group) => textOf(group).includes("setGroupDisplay"));
  assert.ok(display, "the group is on the page");

  const chips = collect(display, byClass("se-set-chip"));
  assert.deepEqual(chips.map(textOf), ["setDateDetail", "setDateRelative", "setSizeAuto", "setSizeKb"]);
  assert.match(chips[0].props.className, /\bon\b/, "详细日期 is what the list always showed, so it stays the default");
  assert.match(chips[2].props.className, /\bon\b/, "自动转换 is the default too");

  chips[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const dateWrite = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.ok(dateWrite, "the click writes immediately");
  // A patch of exactly this key: the page does not echo a document it read
  // minutes ago back over whatever the panel changed in the meantime.
  assert.deepEqual(dateWrite.body, { list: { dateFormat: "relative" } });

  const afterDate = await driver.settle(() => page(driver, api, t));
  const afterDateChips = collect(
    collect(afterDate, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupDisplay")),
    byClass("se-set-chip"),
  );
  assert.match(afterDateChips[1].props.className, /\bon\b/, "距今时间 is now the chosen chip");

  afterDateChips[3].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sizeWrite = calls.filter((call) => call.method === "PUT").at(-1);
  assert.deepEqual(sizeWrite.body, { list: { sizeFormat: "kb" } });
});

/** The 关于 group. It is no longer the last one on the page — 危险操作 follows it,
 *  because the only irreversible control must not sit above anything — so find
 *  it by its heading instead of by position. */
const aboutGroup = (tree) => collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupAbout"));

const chipLabelled = (tree, key) => collect(tree, byClass("se-set-chip")).find((chip) => textOf(chip) === key);

test("关于 prints the build it is running", async () => {
  const { tree } = await renderSettings();
  const about = aboutGroup(tree);
  assert.match(textOf(about), /setGroupAbout/);
  assert.equal(textOf(collect(about, byClass("se-set-ver"))[0]), "v1.0.0");
  // Four things to press, in the order the group explains them: the check, the
  // clear, and the two pages the project lives on.
  assert.deepEqual(
    collect(about, byClass("se-set-chip")).map(textOf),
    ["setCheckUpdate", "setCacheGo", "setStarGo", "setIssueGo"],
  );
  // Nothing is asked of GitHub until the user presses the button: a settings
  // page that phones home on open is a settings page people remove.
  assert.equal(collect(about, byClass("se-set-err")).length, 0);
});

test("检查更新 asks the host once and reports the newer release", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    update: {
      current: "1.0.0",
      latest: "1.0.1",
      hasUpdate: true,
      url: "https://github.com/Anlerway/dsh-session-explorer/releases",
      name: "1.0.1",
      publishedAt: null,
      notes: "",
      checkedAt: 0,
    },
  });
  chipLabelled(tree, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const asked = calls.find((call) => call.method === "GET" && /\/update/.test(call.url));
  assert.ok(asked, "the check is a host request — api.github.com sends no CORS headers");
  // The first press uses the short-lived cache; only a second press forces.
  assert.doesNotMatch(asked.url, /force=1/);

  const after = await driver.settle(() => page(driver, api, t));
  assert.match(textOf(aboutGroup(after)), /setUpdateAvailable/);

  chipLabelled(after, "setDownload").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const opened = calls.find((call) => call.method === "POST" && call.url.endsWith("/about/open"));
  assert.ok(opened, "the browser is opened by the host, not by the page");
  // A named target, never a URL: the host owns the allowlist.
  assert.deepEqual(opened.body, { target: "releases" });
});

test("a second press of 检查更新 bypasses the cached answer", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    update: { current: "1.0.0", latest: "1.0.0", hasUpdate: false, url: "", name: "", publishedAt: null, notes: "", checkedAt: 0 },
  });
  chipLabelled(tree, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  assert.match(textOf(aboutGroup(after)), /setUpdateLatest/);

  chipLabelled(after, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const checks = calls.filter((call) => call.method === "GET" && /\/update/.test(call.url));
  assert.equal(checks.length, 2);
  assert.match(checks[1].url, /force=1/);
});

test("a failed 检查更新 says so instead of claiming the build is current", async () => {
  const { tree, driver, api, t } = await renderSettings();
  chipLabelled(tree, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(aboutGroup(after));
  assert.match(text, /setUpdateFailed/);
  assert.doesNotMatch(text, /setUpdateLatest/);
});

test("清理缓存 reports what came back, and skips a download in flight", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    clear: {
      freedBytes: 1_500_000,
      caches: ["sessions", "log-facts"],
      tmp: { removed: 2, bytes: 1_500_000 },
      downloads: { removed: 0, bytes: 0 },
      staging: { removed: 0, bytes: 0 },
      skipped: ["component-busy"],
      tookMs: 4,
    },
  });
  chipLabelled(tree, "setCacheGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const cleared = calls.find((call) => call.method === "POST" && call.url.endsWith("/cache/clear"));
  assert.ok(cleared);
  // No revision is cited: a clear must not 409 because another window toggled a
  // switch while this page was open.
  assert.equal(cleared.headers["if-match"], undefined);

  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(aboutGroup(after));
  assert.match(text, /setCacheFreed/);
  assert.match(text, /setCacheSkipped/, "a busy component's download directory is skipped, not deleted");
});

test("Star opens the repository through the host", async () => {
  const { tree, calls } = await renderSettings();
  chipLabelled(tree, "setStarGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const opened = calls.find((call) => call.method === "POST" && call.url.endsWith("/about/open"));
  assert.ok(opened);
  assert.deepEqual(opened.body, { target: "star" });
});

/** The 危险操作 group, found by its heading. */
const dangerGroup = (tree) => collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupDanger"));

const dangerChip = (tree, key) => collect(dangerGroup(tree), byClass("se-set-chip")).find((chip) => textOf(chip) === key);

/** Open the group and type into its box, settling after each step the way a user
 *  would: the page re-renders between keystrokes. */
async function typeConfirmation({ driver, api, t }, text) {
  const after = await driver.settle(() => page(driver, api, t));
  const input = collect(dangerGroup(after), byClass("se-set-input"))[0];
  assert.ok(input, "the confirmation box is open");
  input.props.onChange({ target: { value: text } });
  return driver.settle(() => page(driver, api, t));
}

test("清除数据 sits last, behind its own heading, and asks nothing until pressed", async () => {
  const { tree } = await renderSettings();
  const groups = collect(tree, byClass("se-set-grp"));
  assert.equal(groups[groups.length - 1], dangerGroup(tree), "the irreversible group is the last one on the page");
  // Closed by default: one row, one button, and no text box to type into.
  assert.equal(collect(dangerGroup(tree), byClass("se-set-input")).length, 0);
  assert.deepEqual(collect(dangerGroup(tree), byClass("se-set-chip")).map(textOf), ["setResetGo"]);
  assert.match(collect(dangerGroup(tree), byClass("se-set-hint"))[0] ? textOf(collect(dangerGroup(tree), byClass("se-set-hint"))[0]) : "", /setResetHint/);
});

test("the red button stays asleep until DELETE is typed exactly", async () => {
  const ctx = await renderSettings();
  const { tree, driver, api, t } = ctx;
  dangerChip(tree, "setResetGo").props.onClick();

  let after = await driver.settle(() => page(driver, api, t));
  const input = collect(dangerGroup(after), byClass("se-set-input"))[0];
  assert.ok(input, "pressing 清除数据… opens the box");
  assert.equal(input.props.placeholder, "setResetPlaceholder");

  const asleep = () => dangerChip(after, "setResetConfirm");
  assert.equal(asleep().props.disabled, true, "an empty box cannot delete anything");

  // A near miss is not a confirmation: the host compares the same string, so the
  // page must not light up for anything it would then have to refuse.
  after = await typeConfirmation(ctx, "delete");
  assert.equal(dangerChip(after, "setResetConfirm").props.disabled, true, "lower case is a near miss");

  after = await typeConfirmation(ctx, "DELETE please");
  assert.equal(dangerChip(after, "setResetConfirm").props.disabled, true, "extra words are a near miss");

  after = await typeConfirmation(ctx, "  DELETE  ");
  const ready = dangerChip(after, "setResetConfirm");
  assert.equal(ready.props.disabled, false, "surrounding spaces are trimmed on both sides");
  assert.match(ready.props.className, /\bdanger\b/);
  assert.match(ready.props.className, /\bon\b/, "the armed button is visibly the red one");

  // Nothing was sent while the box was being typed into.
  assert.equal(ctx.calls.filter((call) => call.url.endsWith("/data/reset")).length, 0);
});

test("确认清除 posts the typed word and reports what it freed", async () => {
  const ctx = await renderSettings({ interpolate: true });
  const { tree, driver, api, t } = ctx;
  dangerChip(tree, "setResetGo").props.onClick();
  await driver.settle(() => page(driver, api, t));
  let after = await typeConfirmation(ctx, "DELETE");

  dangerChip(after, "setResetConfirm").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const sent = ctx.calls.find((call) => call.method === "POST" && call.url.endsWith("/data/reset"));
  assert.ok(sent, "the reset goes to the host");
  assert.deepEqual(sent.body, { confirm: "DELETE" });
  // No revision is cited: the document the page read is the one being deleted,
  // so an If-Match would turn the last step into a 409.
  assert.equal(sent.headers["if-match"], undefined);

  after = await driver.settle(() => page(driver, api, t));
  const done = collect(dangerGroup(after), byClass("se-set-note")).map(textOf).join("");
  assert.match(done, /setResetDone/);
  assert.match(done, /2\.0 KB|2 KB|2048/, "the freed size is printed, not just 'done'");
  // The page re-read the document it just deleted, so the controls above are the
  // defaults on disk rather than the values it had been showing.
  assert.ok(ctx.calls.filter((call) => call.method === "GET" && call.url.endsWith("/settings")).length >= 2);
  // And the box is closed again, so a second press takes the same two steps.
  assert.equal(collect(dangerGroup(after), byClass("se-set-input")).length, 0);
});

test("取消 closes the box without asking the host anything", async () => {
  const ctx = await renderSettings();
  const { tree, driver, api, t } = ctx;
  dangerChip(tree, "setResetGo").props.onClick();
  let after = await driver.settle(() => page(driver, api, t));
  after = await typeConfirmation(ctx, "DELETE");

  dangerChip(after, "setResetCancel").props.onClick();
  after = await driver.settle(() => page(driver, api, t));

  assert.equal(collect(dangerGroup(after), byClass("se-set-input")).length, 0);
  assert.equal(ctx.calls.filter((call) => call.url.endsWith("/data/reset")).length, 0);
  // Re-opening starts from an empty box: the word is not remembered between tries.
  dangerChip(after, "setResetGo").props.onClick();
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(collect(dangerGroup(after), byClass("se-set-input"))[0].props.value, "");
});

test("a refused reset shows the host's reason and keeps the box open", async () => {
  const fetchImpl = recordingFetch((call) => {
    const path = call.url.replace(/^.*?\/api/, "");
    if (path === "/settings" && call.method === "GET") return { ok: true, result: settingsDocument("panel", "absent") };
    if (path === "/data/reset") return { ok: false, code: "confirm-required", error: "type DELETE to confirm; nothing was deleted" };
    return { ok: true, result: {} };
  });
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key, vars) => interpolating(key, vars);
  const ctx = { driver, api, t };
  const tree = await driver.settle(() => page(driver, api, t));

  dangerChip(tree, "setResetGo").props.onClick();
  await driver.settle(() => page(driver, api, t));
  let after = await typeConfirmation(ctx, "DELETE");
  dangerChip(after, "setResetConfirm").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  after = await driver.settle(() => page(driver, api, t));
  const failure = collect(dangerGroup(after), byClass("se-set-err")).map(textOf).join("");
  assert.match(failure, /setResetFailed/);
  assert.match(failure, /type DELETE to confirm/, "the host's sentence is shown, not swallowed");
  assert.equal(collect(dangerGroup(after), byClass("se-set-input")).length, 1, "the box stays open so the user can fix the word");
});


