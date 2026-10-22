/**
 * dsh-session-explorer — export one session to Markdown or JSONL.
 *
 * A session log is the *truth* but not a conversation: it is a JSONL stream of
 * events (turns, steps, tool calls, compaction markers, surface replacements),
 * and replaying it naively exports text the user already deleted. Two things
 * make this module non-trivial:
 *
 *   1. **Surface operations.** Compaction does not rewrite old events; it
 *      appends a `surfaceOp: replace` event that masks an earlier range. A
 *      sequential read therefore sees the pre-compaction transcript *and* the
 *      summary. The exporter honours the masking: it keeps the latest surface
 *      statement over each seq and drops the events it replaces.
 *
 *   2. **Message shape.** Only `user/message` and `assistant/message` carry
 *      chat content, and the content is a block list (text / reasoning / tool).
 *      A tool call is part of the assistant's turn, not a separate message, so
 *      it is folded into the turn that made it.
 *
 * Pure on the event array: the caller does the I/O, so this is directly
 * testable and the route layer stays a thin adapter.
 */

/**
 * @typedef {object} ExportOptions
 * @property {"md" | "jsonl"} format
 * @property {boolean} [includeTools] whether tool calls appear in Markdown
 * @property {boolean} [includeReasoning] whether reasoning blocks appear
 */

/**
 * Which seqs are still visible after every surface operation.
 *
 * `replace` masks a range; a later replace can mask an earlier one, so the
 * result is "the last statement about each seq wins". A `hide` masks exactly
 * the seqs it names.
 *
 * @param {any[]} events
 * @returns {Set<number>} hidden seqs
 */
export function maskedSeqs(events) {
  const hidden = new Set();
  // The longest range one `surfaceOp` may claim. A real compaction range is a
  // few dozen seqs; anything past this is a corrupt or hostile log, and looping
  // over it would hang the request that exports it.
  const MAX_MASKED_RANGE = 100_000;
  for (const event of events) {
    const op = event?.surfaceOp ?? null;
    if (!op || typeof op !== "object") continue;
    const kind = op.kind ?? op.type;
    const ranges = Array.isArray(op.ranges) ? op.ranges : [];
    if (kind === "replace" || kind === "hide") {
      for (const range of ranges) {
        const from = Number(range?.from ?? range?.start ?? NaN);
        const to = Number(range?.to ?? range?.end ?? NaN);
        if (!Number.isFinite(from)) continue;
        // A range that names only its start hides that one seq. The old code
        // required both ends, computed NaN and `continue`d, so the mask quietly
        // did nothing and the content it was meant to hide was exported.
        const last = Number.isFinite(to) ? to : from;
        if (last < from) continue;
        // `to` is not trusted: a log that says `{"from":1,"to":1000000000}`
        // used to run a billion iterations on the request thread and build a
        // billion-entry Set. A mask longer than this is malformed, not a range.
        const end = Math.min(last, from + MAX_MASKED_RANGE - 1);
        for (let seq = from; seq <= end; seq += 1) hidden.add(seq);
      }
      // A replace that names the seqs directly (`seqs: [...]`) is also possible.
      if (Array.isArray(op.seqs)) for (const seq of op.seqs) if (Number.isFinite(Number(seq))) hidden.add(Number(seq));
    }
  }
  return hidden;
}

/**
 * Flatten one content block list into `{ text, reasoning, tools }`.
 *
 * @param {any} content
 * @returns {{ text: string, reasoning: string, tools: any[] }}
 */
export function blocksOf(content) {
  const parts = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  let text = "";
  let reasoning = "";
  const tools = [];
  for (const block of parts) {
    if (!block || typeof block !== "object") continue;
    const type = block.type ?? block.kind ?? "";
    if (type === "text" || type === "output_text") text += String(block.text ?? "");
    else if (type === "reasoning" || type === "thinking") reasoning += String(block.text ?? block.reasoning ?? "");
    else if (type === "tool-call" || type === "tool_use" || type === "tool") tools.push(block);
    // Everything else used to be dropped, and a message whose only blocks were
    // images, tool results or a type this build does not know then vanished from
    // both formats entirely. Whatever the block can say in words is kept, and an
    // image leaves a marker so the turn is still visibly there.
    else if (typeof block.text === "string") text += block.text;
    else if (type === "image" || type === "input_image") text += "![图片]";
  }
  return { text, reasoning, tools };
}

/**
 * Turn the event stream into ordered turns.
 *
 * @param {any[]} events
 * @returns {{ role: "user" | "assistant" | "system", text: string, reasoning: string, tools: any[], at: number | null, seq: number }[]}
 */
export function turnsOf(events) {
  const hidden = maskedSeqs(events);
  /** @type {any[]} */
  const turns = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (Number.isFinite(event.seq) && hidden.has(event.seq)) continue;
    const type = event.type ?? "";
    if (type !== "user/message" && type !== "assistant/message" && type !== "system/message") continue;
    const { text, reasoning, tools } = blocksOf(event.data?.content ?? event.content ?? event.data?.text ?? "");
    if (!text && !reasoning && tools.length === 0) continue;
    turns.push({
      role: type === "user/message" ? "user" : type === "system/message" ? "system" : "assistant",
      text,
      reasoning,
      tools,
      at: Number.isFinite(event.at) ? event.at : Number.isFinite(event.time) ? event.time : null,
      seq: Number.isFinite(event.seq) ? event.seq : turns.length,
    });
  }
  return turns;
}

/**
 * @param {any} value
 * @returns {string}
 */
function stamp(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Render a session as Markdown.
 *
 * The title is a heading, every turn a labelled section, and tool calls become
 * collapsible detail blocks so a long agentic session stays readable.
 *
 * @param {{ header: any, events: any[] }} artifact
 * @param {{ title?: string } & ExportOptions} options
 * @returns {string}
 */
export function toMarkdown(artifact, options) {
  const turns = turnsOf(artifact?.events ?? []);
  const header = artifact?.header ?? {};
  const title = options?.title || header.title || header.cwd || header.id || "session";
  const includeTools = options?.includeTools === true;
  const includeReasoning = options?.includeReasoning === true;
  const lines = [];
  lines.push(`# ${String(title).replace(/\r?\n/g, " ")}`);
  lines.push("");
  const facts = [];
  if (header.id) facts.push(`- 会话 id：\`${header.id}\``);
  if (header.cwd) facts.push(`- 工作目录：\`${header.cwd}\``);
  if (Number.isFinite(header.createdAt)) facts.push(`- 创建时间：${stamp(header.createdAt)}`);
  if (Number.isFinite(turns.length)) facts.push(`- 消息数：${turns.length}`);
  if (facts.length > 0) {
    lines.push(...facts);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  for (const turn of turns) {
    const label = turn.role === "user" ? "用户" : turn.role === "system" ? "系统" : "助手";
    const when = stamp(turn.at);
    lines.push(`## ${label}${when ? ` · ${when}` : ""}`);
    lines.push("");
    if (includeReasoning && turn.reasoning.trim()) {
      lines.push("> 思考");
      for (const line of turn.reasoning.trim().split(/\r?\n/)) lines.push(`> ${line}`);
      lines.push("");
    }
    if (turn.text.trim()) {
      lines.push(turn.text.trim());
      lines.push("");
    }
    if (includeTools) {
      for (const call of turn.tools) {
        const name = call.name ?? call.toolName ?? "tool";
        const args = call.arguments ?? call.input ?? null;
        lines.push(`<details><summary>工具调用 · ${String(name)}</summary>`);
        lines.push("");
        lines.push("~~~json");
        lines.push(JSON.stringify(args, null, 2) ?? "null");
        lines.push("~~~");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Render a session as JSONL: one turn per line, plus a header line.
 *
 * This is not the raw log — it is the *conversation*, which is what a JSONL user
 * wants to re-ingest. Keeping the raw log would defeat the point of exporting.
 *
 * @param {{ header: any, events: any[] }} artifact
 * @returns {string}
 */
export function toJsonl(artifact) {
  const turns = turnsOf(artifact?.events ?? []);
  const header = artifact?.header ?? {};
  const lines = [
    JSON.stringify({
      type: "session",
      id: header.id ?? null,
      title: header.title ?? null,
      cwd: header.cwd ?? null,
      createdAt: header.createdAt ?? null,
      turns: turns.length,
    }),
  ];
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        role: turn.role,
        at: turn.at,
        text: turn.text,
        ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
        ...(turn.tools.length > 0 ? { tools: turn.tools } : {}),
      }),
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * A filesystem-safe file name for one export.
 *
 * @param {any} header
 * @param {string} title
 * @param {"md" | "jsonl"} format
 * @returns {string}
 */
export function exportFileName(header, title, format) {
  const cleaned = String(title || header?.title || header?.id || "session")
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  // Truncate by code point, not by UTF-16 unit: `.slice(0, 80)` cut an emoji in
  // half and left a lone surrogate, which `encodeURIComponent` in the download
  // route then rejected as `URIError: URI malformed` — the export became a 500.
  const base = Array.from(cleaned).slice(0, 80).join("") || "session";
  return `${base}.${format === "jsonl" ? "jsonl" : "md"}`;
}
