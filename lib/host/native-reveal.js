/**
 * Reveal a file or folder through the shell's own API.
 *
 * Windows exposes exactly one call for "open this folder and select this item":
 * `SHOpenFolderAndSelectItems` in shell32. It is what Explorer's own "Show in
 * folder" verb, Electron's `shell.showItemInFolder` and every file manager use,
 * so it both opens and foregrounds the window in ~15ms — no helper process, no
 * polling, no keybd_event tricks.
 *
 * The call needs two arguments Explorer would otherwise prepare for us (an ITEMIDLIST
 * and a COM apartment), so the plugin reaches them through koffi, a prebuilt
 * Node-API FFI binding. When that binding is missing (unsupported platform, a
 * store that skipped optional binaries, a future Node ABI) every function here
 * returns `null` and the caller falls back to the PowerShell path: a missing
 * binding costs speed, never function.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * @typedef {{ ok: boolean, detail: string }} RevealResult
 * @typedef {{
 *   parse: (name: string, bindCtx: null, pidl: unknown[], attrsIn: number, attrsOut: number[]) => number,
 *   openAndSelect: (pidlFolder: unknown, count: number, pidls: null, flags: number) => number,
 *   coTaskMemFree: (mem: unknown) => void,
 * }} ShellApi
 */

/** @type {ShellApi | null} */
let bound = null;
let unavailable = false;

/** @returns {ShellApi | null} */
function api() {
  if (bound || unavailable) return bound;
  try {
    const koffi = require("koffi");
    const shell32 = koffi.load("shell32.dll");
    const ole32 = koffi.load("ole32.dll");
    const coInitialize = ole32.func("long __stdcall CoInitializeEx(void *reserved, uint32 mode)");
    const coTaskMemFree = ole32.func("void __stdcall CoTaskMemFree(void *mem)");
    const parse = shell32.func(
      "long __stdcall SHParseDisplayName(const char16_t *name, void *bindCtx, _Out_ void **pidl, uint32 attrsIn, _Out_ uint32 *attrsOut)",
    );
    const openAndSelect = shell32.func(
      "long __stdcall SHOpenFolderAndSelectItems(void *pidlFolder, uint32 count, void **pidls, uint32 flags)",
    );
    // The shell COM objects need an apartment. S_FALSE (already initialised) and
    // RPC_E_CHANGED_MODE (another mode on this thread) are both fine: the call
    // below works either way.
    coInitialize(null, 2 /* COINIT_APARTMENTTHREADED */);
    bound = { parse, openAndSelect, coTaskMemFree };
  } catch {
    unavailable = true;
  }
  return bound;
}

/**
 * Ask Explorer to open `target`'s folder and select it.
 *
 * @param {string} target Absolute path. Forward slashes are converted: the shell
 *   API rejects them outright (`E_INVALIDARG`), unlike every Node API.
 * @returns {RevealResult | null} `null` when the native binding is unavailable.
 */
export function revealNatively(target) {
  const shell = api();
  if (!shell) return null;
  if (process.platform !== "win32") return null;
  const native = target.replace(/\//g, "\\");
  try {
    const pidl = [null];
    const attrs = [0];
    const parsed = shell.parse(native, null, pidl, 0, attrs);
    if (parsed !== 0 || !pidl[0]) {
      return { ok: false, detail: `parse 0x${(parsed >>> 0).toString(16)}` };
    }
    try {
      const opened = shell.openAndSelect(pidl[0], 0, null, 0);
      return { ok: opened === 0, detail: opened === 0 ? "shell" : `open 0x${(opened >>> 0).toString(16)}` };
    } finally {
      shell.coTaskMemFree(pidl[0]);
    }
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
}

/**
 * Whether the native path will be used, without opening anything.
 *
 * Binding is cheap (two library loads and five signatures); doing it at panel
 * open means the first reveal does not pay for it. It also tells the host
 * whether the PowerShell fallback is worth warming at all.
 *
 * @returns {boolean}
 */
export function nativeRevealAvailable() {
  return api() !== null;
}

/** Test seam: forget the binding so a test can exercise the "missing koffi" path. */
export function forgetNativeBinding() {
  bound = null;
  unavailable = true;
}
