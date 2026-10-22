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
  };
}

/** One render of the page, through the driver so its hooks get a stable scope. */
const page = (driver, api, t) => driver.render(driver.React.createElement(api.SettingsSection, { t }));

/** Render the page against a document, and hand back the tree and the calls. */
async function renderSettings({ mode = "panel", component = "absent" } = {}) {
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
      return { ok: true, result: { settings: doc.settings, revision: 5 } };
    }
    // The component group re-probes on mount and reports the phase upward, so
    // the launch chips have to agree with it — a stub that answered nothing
    // would leave 独立弹窗 disabled however the document was written.
    if (path === "/component/status") {
      return { ok: true, result: { phase: component, version: "1.0.0", installed: component === "ready" } };
    }
    return { ok: true, result: {} };
  });
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key) => key;
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
