/**
 * A very small DOM for the detached shell's render tests.
 *
 * The shell builds every pane from template strings and delegates every event
 * from #root, so testing it needs three things the old stub did not have: an
 * HTML parser (so querySelector can find what was rendered), event dispatch with
 * bubbling (so a click on a button reaches the delegated listener), and enough
 * element state for inputs, checkboxes and classList.
 *
 * It is not a browser: no layout, no CSS, no shadow DOM, no HTML error recovery.
 * It parses exactly the markup this project emits and fails loudly otherwise.
 */

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr", "path", "circle", "rect", "line", "polyline",
  "polygon", "ellipse", "use", "stop",
]);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: "\u00a0" };

export function decodeEntities(text) {
  return String(text).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function escapeText(value) {
  return String(value ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
}

class ClassList {
  constructor(element) {
    this.element = element;
  }
  get set() {
    return new Set(String(this.element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
  }
  write(set) {
    this.element.setAttribute("class", [...set].join(" "));
  }
  add(...names) {
    const set = this.set;
    for (const name of names) set.add(name);
    this.write(set);
  }
  remove(...names) {
    const set = this.set;
    for (const name of names) set.delete(name);
    this.write(set);
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const has = this.contains(name);
    const next = force === undefined ? !has : Boolean(force);
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

export class Event {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.target = init.target ?? null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
}

export class TextNode {
  constructor(text) {
    this.text = text;
    this.parentNode = null;
  }
  get textContent() {
    return this.text;
  }
}

export class Node {
  constructor(document, tagName, attributes = {}) {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.style = {};
    this.value = "";
    this.checked = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this._text = "";
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }
  set id(value) {
    this.setAttribute("id", value);
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  get dataset() {
    const out = {};
    for (const [key, value] of this.attributes) {
      if (!key.startsWith("data-")) continue;
      const name = key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      out[name] = value;
    }
    return out;
  }

  getAttribute(name) {
    const value = this.attributes.get(String(name).toLowerCase());
    return value === undefined ? null : value;
  }
  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }
  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }
  get children() {
    return this.childNodes.filter((node) => node instanceof Node);
  }

  get textContent() {
    return this.childNodes.map((node) => (node instanceof Node ? node.textContent : node.text)).join("");
  }
  set textContent(value) {
    this.childNodes = [];
    this._text = String(value);
  }

  get innerHTML() {
    return serialize(this);
  }
  set innerHTML(html) {
    this.childNodes = [];
    const nodes = parseHTML(this.ownerDocument, String(html ?? ""));
    for (const node of nodes) this.appendChild(node);
  }

  addEventListener(type, handler) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type, handler) {
    const bucket = this.listeners.get(type) ?? [];
    this.listeners.set(type, bucket.filter((entry) => entry !== handler));
  }

  dispatchEvent(event) {
    let current = this;
    if (!event.target) event.target = this;
    while (current) {
      event.currentTarget = current;
      const bucket = current.listeners?.get(event.type) ?? [];
      for (const handler of bucket.slice()) {
        handler.call(current, event);
        if (event.propagationStopped) return event;
      }
      if (!event.bubbles) break;
      current = current.parentNode;
    }
    return event;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  matches(selector) {
    for (const part of String(selector).split(",")) {
      if (matchSimple(this, part.trim())) return true;
    }
    return false;
  }

  querySelector(selector) {
    for (const node of walk(this)) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    for (const node of walk(this)) {
      if (node.matches(selector)) out.push(node);
    }
    return out;
  }

  contains(other) {
    let current = other;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  select() {
    this.selectionStart = 0;
    this.selectionEnd = String(this.value ?? "").length;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

function walk(node) {
  const out = [];
  const stack = [...node.children].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    out.push(current);
    const kids = current.children;
    for (let index = kids.length - 1; index >= 0; index -= 1) stack.push(kids[index]);
  }
  return out;
}

/**
 * Match one simple selector: tag, .class, #id and [attr], in any combination.
 * Descendant combinators are not needed by this page and are not supported.
 */
function matchSimple(node, selector) {
  if (!selector) return false;
  const head = selector.match(/^([a-zA-Z][\w-]*)?((?:\[[^\]]*\]|\.[\w-]+|#[\w-]+)*)$/);
  if (!head) return false;
  const tag = head[1];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  const tokens = head[2] ?? "";
  const pattern = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]|\.([\w-]+)|#([\w-]+)/g;
  let match;
  while ((match = pattern.exec(tokens)) !== null) {
    if (match[1]) {
      const value = node.getAttribute(match[1]);
      if (value === null) return false;
      const expected = match[2] ?? match[3] ?? match[4];
      if (expected !== undefined && value !== expected) return false;
    } else if (match[5]) {
      if (!node.classList.contains(match[5])) return false;
    } else if (match[6]) {
      if (node.id !== match[6]) return false;
    }
  }
  // Anything left over means the selector used a form this matcher cannot read.
  return tokens.replace(pattern, "").trim() === "";
}

function serialize(node) {
  if (node instanceof TextNode) return escapeText(node.text);
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attributes]
    .map(([key, value]) => " " + key + '="' + String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"')
    .join("");
  if (VOID_TAGS.has(tag)) return "<" + tag + attrs + ">";
  const body = node.childNodes.map((child) => serialize(child)).join("");
  return "<" + tag + attrs + ">" + body + "</" + tag + ">";
}

/** Parse the subset of HTML this project emits. */
function parseHTML(document, html) {
  const rootNode = { childNodes: [], children: [], tagName: "#ROOT" };
  const stack = [rootNode];
  const tagPattern = /<\/?([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let cursor = 0;
  let match;

  const pushText = (text) => {
    if (!text) return;
    const parent = stack[stack.length - 1];
    const node = new TextNode(decodeEntities(text));
    node.parentNode = parent;
    parent.childNodes.push(node);
  };

  while ((match = tagPattern.exec(html)) !== null) {
    pushText(html.slice(cursor, match.index));
    cursor = tagPattern.lastIndex;
    const [whole, rawTag, rawAttrs] = match;
    const closing = whole.startsWith("</");
    const tag = rawTag.toLowerCase();

    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tagName.toLowerCase() === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const attributes = {};
    const attrPattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(rawAttrs ?? "")) !== null) {
      attributes[attrMatch[1].toLowerCase()] = decodeEntities(attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "");
    }

    const element = new Node(document, tag, attributes);
    // A real input reflects its value/checked attributes into the properties the
    // shell reads back; without this an inline rename would start empty.
    if (tag === "input") {
      element.value = attributes.value ?? "";
      element.checked = Object.prototype.hasOwnProperty.call(attributes, "checked");
    }
    const parent = stack[stack.length - 1];
    element.parentNode = parent;
    parent.childNodes.push(element);
    if (!VOID_TAGS.has(tag) && !whole.endsWith("/>")) stack.push(element);
  }
  pushText(html.slice(cursor));
  return rootNode.childNodes;
}

/** Create a document plus the window globals the shell reads. */
export function createDom(initialStorage) {
  const document = {
    readyState: "loading",
    activeElement: null,
    listeners: new Map(),
    body: null,
    documentElement: null,
    getElementById(id) {
      return walk(document.body).find((node) => node.id === id) ?? null;
    },
    createElement(tag) {
      return new Node(document, tag);
    },
    createTextNode(text) {
      return new TextNode(text);
    },
    querySelector(selector) {
      return document.body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return document.body.querySelectorAll(selector);
    },
    addEventListener(type, handler) {
      const bucket = document.listeners.get(type) ?? [];
      bucket.push(handler);
      document.listeners.set(type, bucket);
    },
    removeEventListener(type, handler) {
      const bucket = document.listeners.get(type) ?? [];
      document.listeners.set(type, bucket.filter((entry) => entry !== handler));
    },
    dispatchEvent(event) {
      for (const handler of (document.listeners.get(event.type) ?? []).slice()) handler.call(document, event);
      return event;
    },
  };

  document.body = new Node(document, "body");
  const root = new Node(document, "div");
  root.setAttribute("id", "root");
  document.body.appendChild(root);
  document.documentElement = document.body;

  const windowListeners = new Map();
  const storage = new Map(initialStorage ? [...initialStorage] : []);
  const window = {
    document,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, handler) {
      const bucket = windowListeners.get(type) ?? [];
      bucket.push(handler);
      windowListeners.set(type, bucket);
    },
    removeEventListener(type, handler) {
      const bucket = windowListeners.get(type) ?? [];
      windowListeners.set(type, bucket.filter((entry) => entry !== handler));
    },
    dispatchEvent(event) {
      for (const handler of (windowListeners.get(event.type) ?? []).slice()) handler.call(window, event);
      return event;
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    navigator: { clipboard: { writeText: async () => {} } },
  };

  return { document, window, root, storage };
}

/** Click an element, bubbling to the delegated listener. */
export function click(node, init = {}) {
  const event = new Event("click", { bubbles: true, target: node, clientX: 40, clientY: 40, ...init });
  node.dispatchEvent(event);
  return event;
}

/** Type into an input and fire the input event the shell listens for. */
export function type(node, value) {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true, target: node }));
}

/** Press a key on the window (the shell binds shortcuts there). */
export function press(window, key, init = {}) {
  const event = new Event("keydown", { bubbles: true, key, ...init });
  window.dispatchEvent(event);
  return event;
}

/** Right-click an element. */
export function contextMenu(node, x = 60, y = 80) {
  const event = new Event("contextmenu", { bubbles: true, target: node, clientX: x, clientY: y });
  node.dispatchEvent(event);
  return event;
}
