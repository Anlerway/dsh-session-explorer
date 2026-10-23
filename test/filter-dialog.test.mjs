/**
 * The 筛选 dialog's two exits.
 *
 * 重置 empties the form and still needs 应用筛选; 取消筛选 drops the filter that is
 * actually in effect and closes in one step. The test pins that difference, and
 * pins that the second one does not exist when there is nothing to cancel.
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

/** Every draft the dialog tries to store, in order. */
const drafts = [];

/** The harness's React stub, with a useState that records its setter. */
const react = {
  Component: class {
    constructor(props) {
      this.props = props;
    }
  },
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  createPortal: (node) => node,
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => {
    const value = typeof initial === "function" ? initial() : initial;
    return [value, (next) => drafts.push(typeof next === "function" ? next(value) : next)];
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

const { test: api } = loadClientBundle({ expose: ["FilterDialog", "EMPTY_FILTER"], react });

/** Every element in a rendered tree, depth first. */
function elements(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out);
    return out;
  }
  if (node.type) out.push(node);
  for (const child of node.children ?? []) elements(child, out);
  return out;
}

/** The text inside an element, concatenated. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children ?? []).map(textOf).join("");
}

/** The button whose label is `label`, if the dialog drew one. */
function button(tree, label) {
  return elements(tree).find((node) => node.type === "button" && textOf(node) === label);
}

function render({ active, onApply = () => {}, onClear = () => {}, onClose = () => {} }) {
  return api.FilterDialog({
    open: true,
    value: { ...api.EMPTY_FILTER },
    library: [],
    active,
    onApply,
    onClear,
    onClose,
  });
}

test("with no filter in effect there is nothing to cancel", () => {
  const tree = render({ active: false });
  assert.equal(button(tree, "取消筛选"), undefined);
  // The form is still usable: 重置 and 应用筛选 are always there.
  assert.ok(button(tree, "重置"));
  assert.ok(button(tree, "应用筛选"));
});

test("取消筛选 appears once a filter is applied and clears it in one step", () => {
  const calls = [];
  drafts.length = 0;
  const tree = render({ active: true, onClear: () => calls.push("clear") });
  const cancel = button(tree, "取消筛选");
  assert.ok(cancel, "the exit hatch is drawn next to 应用筛选");
  cancel.props.onClick();
  assert.deepEqual(calls, ["clear"]);
  // It does not touch the draft: the applied filter is what gets dropped.
  assert.deepEqual(drafts, []);
});

test("重置 only empties the form — 应用筛选 still decides", () => {
  const calls = [];
  drafts.length = 0;
  const tree = render({
    active: true,
    onApply: (next) => calls.push(["apply", next]),
    onClear: () => calls.push("clear"),
  });
  button(tree, "重置").props.onClick();
  assert.deepEqual(drafts, [{ ...api.EMPTY_FILTER }]);
  assert.deepEqual(calls, [], "reset is a draft change, not an application");
});

test("an empty form is what a first-time filter starts from", () => {
  assert.deepEqual(api.EMPTY_FILTER, { scope: "scope", favorite: "all", archived: "all", todo: "all", tags: [] });
});
