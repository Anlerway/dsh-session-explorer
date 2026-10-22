/**
 * dsh-session-explorer — the bridge between the floating panel and the detached
 * window.
 *
 * The two surfaces are two documents in two processes, and neither can call the
 * other directly:
 *
 *   panel    runs inside DSH; it owns `uiWorkspace`, so it is the only side that
 *            can actually *open* a session or start a new one;
 *   window   runs in its own Electron process, executing the same module on a
 *            page the Host serves; its `uiWorkspace` is a stub that can only
 *            publish, so navigation still has to travel through here.
 *
 * What they *do* share is this Host. So the Host keeps a small, in-memory command
 * queue and turns it into a push channel:
 *
 *   window  --POST /bridge/commands-->  Host  --SSE /bridge/events-->  panel
 *
 * A command is fire-and-forget: the queue is a ring buffer, each consumer keeps
 * its own cursor, and nothing is ever acknowledged. That is deliberate. The
 * alternative — a request/response pipe — would need the panel to answer while
 * it is closed, and a command whose recipient is not listening must not fail;
 * it must simply be dropped, because the user can always click again.
 *
 * Nothing here is persisted: a command is meaningful only to a live listener,
 * so replaying yesterday's "open session" after a restart would be a bug.
 */

/** How many commands to keep. Beyond this the oldest are dropped. */
const CAPACITY = 64;

/** A command's lifetime: a stale "open" would move the user's view unasked. */
const MAX_AGE_MS = 30_000;

/**
 * How many listeners may hold a connection open at once.
 *
 * Every listener is an open SSE response with its own write buffer, and the
 * panel reconnects on its own: without a ceiling, a page that keeps reconnecting
 * (or a leaked response that never emitted `close`) would grow the set for as
 * long as the process lives.
 */
const MAX_LISTENERS = 32;

/**
 * @typedef {object} BridgeCommand
 * @property {number} seq strictly increasing, the consumer's cursor
 * @property {string} kind
 * @property {any} payload
 * @property {number} createdAt
 */

/**
 * Create the in-memory command bus.
 *
 * @param {{ now?: () => number, capacity?: number }} [options]
 */
export function createBridge(options = {}) {
  const now = () => (typeof options.now === "function" ? options.now() : Date.now());
  const capacity = Number.isFinite(options.capacity) && options.capacity > 0 ? options.capacity : CAPACITY;
  /** @type {BridgeCommand[]} */
  let commands = [];
  let seq = 0;
  /** @type {Set<(command: BridgeCommand) => void>} */
  const listeners = new Set();

  /**
   * Publish one command.
   *
   * The payload is not validated here: the Host route decides what a kind means,
   * and a listener that does not recognise it ignores it. Keeping the bus dumb
   * is what lets a newer panel talk to an older window without a schema bump.
   *
   * @param {string} kind
   * @param {any} [payload]
   * @returns {BridgeCommand}
   */
  function publish(kind, payload) {
    const command = { seq: ++seq, kind: String(kind), payload: payload ?? null, createdAt: now() };
    commands.push(command);
    if (commands.length > capacity) commands = commands.slice(commands.length - capacity);
    for (const listener of [...listeners]) {
      try {
        listener(command);
      } catch {
        /* one broken subscriber must not stop the others */
      }
    }
    return command;
  }

  /**
   * Commands after `since`, excluding stale ones.
   *
   * A cursor older than the buffer simply yields everything still held: the
   * consumer missed some, and replaying what survives is better than replaying
   * nothing.
   *
   * @param {number} since
   * @returns {BridgeCommand[]}
   */
  function since(cursor) {
    const from = Number.isFinite(cursor) ? cursor : 0;
    const cutoff = now() - MAX_AGE_MS;
    return commands.filter((command) => command.seq > from && command.createdAt >= cutoff);
  }

  /**
   * @param {(command: BridgeCommand) => void} listener
   * @returns {(() => void) | null} unsubscribe, or null when the bus is full
   */
  function subscribe(listener) {
    if (listeners.size >= MAX_LISTENERS) return null;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    publish,
    since,
    subscribe,
    /** Listeners currently attached, so the route can refuse early. */
    get listeners() {
      return listeners.size;
    },
    /** The newest sequence number; 0 when nothing has ever been published. */
    get cursor() {
      return seq;
    },
    /** Drop everything (tests, and a data-directory migration). */
    clear() {
      commands = [];
      seq = 0;
    },
    get size() {
      return commands.length;
    },
  };
}

/**
 * Kinds a detached window may send. Anything else is refused by the route: the
 * bridge is a narrow pipe, not a remote control for the plugin.
 *
 * `open-settings` is navigation, like the other three: the window has no
 * settings shell, so the press has to be delivered to the DSH page, which does.
 */
export const WINDOW_COMMANDS = Object.freeze(["open-session", "new-session", "reveal", "refresh", "open-settings"]);

/**
 * Coerce an incoming command body into something safe to fan out.
 *
 * @param {any} body
 * @returns {{ kind: string, payload: any }}
 */
export function normalizeCommand(body) {
  const kind = typeof body?.kind === "string" ? body.kind : "";
  if (!WINDOW_COMMANDS.includes(kind)) {
    const error = new Error(`unsupported bridge command: ${kind || "(none)"}`);
    error.code = "bad-request";
    throw error;
  }
  const raw = body?.payload && typeof body.payload === "object" ? body.payload : {};
  /** @type {Record<string, any>} */
  const payload = {};
  for (const key of ["sessionId", "workspaceId", "scope"]) {
    if (typeof raw[key] === "string" && raw[key] !== "") payload[key] = raw[key].slice(0, 200);
  }
  return { kind, payload };
}
