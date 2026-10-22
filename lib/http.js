/**
 * dsh-session-explorer — tiny HTTP helpers for the host half.
 *
 * Every endpoint answers with one of two envelopes:
 *
 *   { ok: true,  result: <json> }
 *   { ok: false, error: "<human readable>", code: "<stable-code>" }
 *
 * `code` is what the client branches on; `error` is only ever shown to a human.
 */

import { API_PREFIX } from "./constants.js";

/** @typedef {{ ok: true, result: unknown }} OkEnvelope */
/** @typedef {{ ok: false, error: string, code: string }} ErrEnvelope */

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {OkEnvelope | ErrEnvelope} body
 */
export function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {unknown} result
 */
export function ok(res, result) {
  send(res, 200, { ok: true, result });
}

/**
 * Send a typed error.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
export function fail(res, status, code, message) {
  send(res, status, { ok: false, error: message, code });
}

/**
 * Read and parse a JSON request body. Empty bodies parse to `{}`.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {number} [limitBytes]
 * @returns {Promise<any>}
 */
export async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error("request body too large");
      err.code = "bad-request";
      throw err;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    const err = new Error("request body is not valid JSON");
    err.code = "bad-request";
    err.cause = cause;
    throw err;
  }
}

/**
 * Split a request URL into the plugin-relative path and its query.
 * Returns `null` when the URL does not belong to this plugin.
 *
 * @param {string | undefined} rawUrl
 * @returns {{ path: string, query: URLSearchParams } | null}
 */
export function routeOf(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    // A request target Node's parser let through but `URL` rejects is not this
    // plugin's route; answering 404 is better than an unhandled throw outside
    // the dispatcher's try/catch.
    return null;
  }
  if (!url.pathname.startsWith(API_PREFIX)) return null;
  const rest = url.pathname.slice(API_PREFIX.length);
  return { path: rest === "" ? "/" : rest, query: url.searchParams };
}
