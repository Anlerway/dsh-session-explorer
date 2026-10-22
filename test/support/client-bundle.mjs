/**
 * Load `lib/client.js` the way the plugin host does, in Node, with no bundler
 * and no DOM.
 *
 * The bundle is a `window.__ModuleLoader__.load({factory})` wrapper, so a stub
 * `window`/`document` and a stub `react` are enough to run it. Anything the
 * tests need to reach is module-private, so the harness appends one export line
 * to a *copy* of the source: widening the production surface for a test would be
 * a worse trade than one string replace.
 *
 * @module test/support/client-bundle
 */
import { readFileSync } from "node:fs";

/** Only what the module touches at definition time. */
const React = {
  Component: class {
    constructor(props) {
      this.props = props;
    }
  },
  Fragment: Symbol("Fragment"),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  createPortal: (node) => node,
  useRef: (initial) => ({ current: initial }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};

/**
 * A fetch that records every call and answers from a script.
 *
 * The client's own `fetch` is the parameter of the bundle function, so this can
 * stand in for the network without touching `globalThis`.
 *
 * @param {(call: { url: string, method: string, headers: Record<string, string>, body: unknown }) => any} [respond]
 */
export function recordingFetch(respond = () => ({ ok: true, result: {} })) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: String(init.method ?? "GET").toUpperCase(),
      headers: { ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const answer = respond(call) ?? { ok: true, result: {} };
    return { status: answer.status ?? 200, json: async () => answer };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/**
 * @param {{ fetch?: any, expose?: string[], document?: any, react?: any }} [options]
 *   `document` and `react` let a test supply a surface the default stubs cannot
 *   describe — a settings modal that opens, a component tree that re-renders.
 * @returns {{ bundle: any, test: Record<string, any>, fetch: any }}
 */
export function loadClientBundle(options = {}) {
  const fetchImpl = options.fetch ?? recordingFetch();
  const expose = options.expose ?? [];
  const react = options.react ?? React;
  const storage = new Map();

  globalThis.window = {
    __ModuleLoader__: { load: ({ factory }) => { bundle = factory(requireShim); } },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  };
  globalThis.document = options.document ?? {
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    getElementById: () => null,
    createTextNode: () => ({}),
  };

  let bundle = null;
  const requireShim = (name) => {
    if (name === "react") return react;
    throw new Error("unexpected require: " + name);
  };

  const source = readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8");
  const anchor = "    exports.apply = apply;";
  if (!source.includes(anchor)) throw new Error("the bundle no longer ends with the export block");
  const patched = expose.length
    ? source.replace(anchor, `    exports.__test = { ${expose.join(", ")} };\n${anchor}`)
    : source;

  new Function("window", "document", "navigator", "fetch", patched)(
    globalThis.window,
    globalThis.document,
    { clipboard: { writeText: async () => {} } },
    fetchImpl,
  );

  if (!bundle) throw new Error("the module factory did not run");
  return { bundle, test: bundle.__test ?? {}, fetch: fetchImpl };
}
