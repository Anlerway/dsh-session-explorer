/**
 * dsh-session-explorer — operations that must go through DSH itself.
 *
 * Rename, fork, archive and pin are all *native* concepts: DSH already owns the
 * session title event, the fork seed, the archived set and the pinned set. The
 * plugin therefore never stores them (hard constraint 2 / S8 in 实现粗规划.md);
 * it calls the same host services the official UI calls, then makes our own
 * derived view catch up.
 *
 * The service names below are the runtime ones registered by the desktop
 * profile (see `dsh-api-session-controller`, `dsh-api-workspace-controller`):
 *
 *   sessionController        rename / fork
 *   workspaceController      rename / archiveSession / unarchiveSession /
 *                            pinSession / unpinSession
 *   sessionProjectionCache   write(session) — flush the L1 projection cache
 *
 * The last one matters: the list title normally comes from the projection cache
 * on disk, which is written on session creation, on `turn/end` and on disposal,
 * and otherwise throttled (200 events / 5 s). A rename appends exactly one
 * `session/title` event, so without an explicit flush the new title could take
 * five seconds to appear. Flushing right after the rename closes that gap at the
 * source instead of papering over it with an in-memory overlay.
 */

import { basename, dirname, join } from "node:path";

import { getService } from "../capabilities.js";
import { codedError } from "../store/sidecar.js";
import { dropShortcutsTo, liftShortcutsFrom } from "../domain/shortcuts.js";
import { trashTargetDir } from "../domain/trash.js";
import { revealNatively } from "./native-reveal.js";
import { revealWithAgent } from "./reveal-agent.js";
import { FIXED_NODES } from "../constants.js";

/**
 * The session controller, or a `capability-missing` error.
 *
 * @param {any} ctx
 * @returns {any}
 */
function sessionControllerOf(ctx) {
  const controller = getService(ctx, "sessionController");
  if (!controller) {
    throw codedError(
      "capability-missing",
      "this DSH build mounts no session controller, so session operations are unavailable",
    );
  }
  return controller;
}

/**
 * The workspace controller, or a `capability-missing` error.
 *
 * @param {any} ctx
 * @returns {any}
 */
function workspaceControllerOf(ctx) {
  const controller = getService(ctx, "workspaceController");
  if (!controller) {
    throw codedError(
      "capability-missing",
      "this DSH build mounts no workspace controller, so workspace operations are unavailable",
    );
  }
  return controller;
}

/**
 * Bring the derived view back in line after a native mutation.
 *
 * The header scan is TTL-cached, so without this a caller that immediately
 * re-reads `/bootstrap` could still see the pre-mutation listing.
 *
 * @param {any} api
 */
function refresh(api) {
  try {
    api.reader.invalidate();
  } catch {
    /* an unavailable reader just means there is nothing cached to drop */
  }
}

/**
 * Flush the L1 projection cache for one session, if this build has one.
 *
 * Best effort on purpose: the rename already succeeded, and failing the whole
 * request because a *cache* could not be refreshed would be worse than showing
 * the new title a few seconds late.
 *
 * @param {any} ctx
 * @param {string} sessionId
 */
async function flushProjection(ctx, sessionId) {
  try {
    const cache = getService(ctx, "sessionProjectionCache");
    const sessions = getService(ctx, "sessions");
    const session = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : null;
    if (!cache || typeof cache.write !== "function" || !session) return;
    await cache.write(session);
  } catch {
    /* see above: a stale cache is a cosmetic delay, not a failure */
  }
}

/**
 * Rename a session by appending a user-authored `session/title` event.
 *
 * DSH treats a user rename as authoritative: it supersedes automatic title
 * generation, so the new name sticks across later turns. The session is resumed
 * first if it is cold — exactly what the official rename does.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {string} title
 * @returns {Promise<{ sessionId: string, title: string, seq: number }>}
 */
export async function renameSession(api, sessionId, title) {
  const controller = sessionControllerOf(api.ctx);
  if (typeof controller.rename !== "function") {
    throw codedError("capability-missing", "this DSH build cannot rename sessions");
  }
  const result = await controller.rename({ sessionId, title });
  await flushProjection(api.ctx, sessionId);
  refresh(api);
  return { sessionId, title: result?.title ?? title, seq: result?.seq ?? -1 };
}

/**
 * Rename a workspace.
 *
 * Duplicate names are rejected by DSH itself (`workspace/name-conflict`); the
 * plugin deliberately does not pre-validate, so its rule can never drift from
 * the host's.
 *
 * @param {any} api
 * @param {string} workspaceId
 * @param {string} title
 * @returns {Promise<{ workspaceId: string, title: string }>}
 */
export async function renameWorkspace(api, workspaceId, title) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.rename !== "function") {
    throw codedError("capability-missing", "this DSH build cannot rename workspaces");
  }
  const result = await controller.rename({ workspaceId, title });
  refresh(api);
  return { workspaceId, title: result?.workspace?.title ?? title };
}

/**
 * Delete a workspace registration, keeping its files and its sessions.
 *
 * This is DSH's own delete: the registry entry goes away, the directory and
 * every session log stay on disk. A session that was grouped under it therefore
 * has no workspace any more, which is exactly what 未分组 is for — it shows up
 * there instead of vanishing. Re-registering the same directory brings the
 * workspace back, sessions and all.
 *
 * @param {any} api
 * @param {string} workspaceId
 * @returns {Promise<{ workspaceId: string, deleted: boolean }>}
 */
export async function deleteWorkspace(api, workspaceId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.delete !== "function") {
    throw codedError("capability-missing", "this DSH build cannot delete workspaces");
  }
  const result = await controller.delete({ workspaceId });
  refresh(api);
  // References die with their target (a shortcut row is not deletable by hand):
  // a workspace's sessions move to 未分组, but a shortcut that pointed at the
  // container itself has nothing left to open.
  await api.documents.tree.mutate((draft) => {
    dropShortcutsTo(draft, "workspace", workspaceId);
    // The workspace node is gone too, so the references that lived *inside* it
    // would be parented to a node the projection no longer renders: the row
    // would be invisible and undeletable. 收藏 is where a reference belongs
    // when it has no container of its own.
    liftShortcutsFrom(draft, `w-${workspaceId}`, FIXED_NODES.favorites);
  });
  return { workspaceId, deleted: result?.deleted !== false };
}

/**
 * Reveal a path in the OS file manager.
 *
 * The OS is asked directly and DSH is the fallback — the opposite order of the
 * first attempt, because DSH's hand-off cannot be trusted to tell the truth in
 * every build: `session.openWorkspacePath` **resolves successfully** where there
 * is no desktop host to receive it (the Web GUI), so the panel reported 已打开
 * while no window had opened. A native spawn either starts a process or fails;
 * that is a signal worth acting on, and DSH stays as the channel for platforms
 * this plugin cannot open by itself.
 *
 * @param {any} api
 * @param {string} path
 * @param {{ select?: boolean }} [options] `select` reveals the item inside its
 *   parent window instead of opening the path itself — the right gesture for a
 *   file, and the wrong one for a folder.
 * @returns {Promise<{ path: string, opened: boolean, via: "native" | "dsh" }>}
 */
export async function revealPath(api, path, options = {}) {
  const target = String(path ?? "");
  if (!target) throw codedError("bad-request", "path is required");
  // Tests hand in their own opener; the host never sets this, so production
  // always goes through the real spawn.
  const outcome =
    typeof api.openInFileManager === "function"
      ? await api.openInFileManager(target, options.select === true)
      : await openNatively(target, options.select === true);
  const native = typeof outcome === "object" && outcome !== null ? outcome.ok === true : outcome === true;
  await traceReveal(api, {
    kind: "path",
    path: target,
    select: options.select === true,
    native,
    via: typeof outcome === "object" && outcome !== null ? outcome.via : "native",
    detail: typeof outcome === "object" && outcome !== null ? outcome.detail : undefined,
  });
  if (native) {
    // `detail` only rides along when the opener could report one: a test stub
    // that answers `true` has no window state to describe.
    const detail = typeof outcome === "object" && outcome !== null ? outcome.detail : undefined;
    return { path: target, opened: true, via: "native", ...(typeof detail === "string" && detail ? { detail } : {}) };
  }
  const controller = sessionControllerOf(api.ctx);
  if (typeof controller.openWorkspacePath !== "function") {
    throw codedError("capability-missing", "this DSH build cannot open a path in the file manager");
  }
  // No `action` by default: `reveal` asks the OS to *select* the item inside
  // its parent window, which is right for a file and wrong for the thing the
  // UI offers — "show me this folder". Opening the path itself hands a
  // directory to Explorer and lands the user where they asked to be.
  if (options.select === true) await controller.openWorkspacePath({ path: target, action: "reveal" });
  else await controller.openWorkspacePath({ path: target });
  return { path: target, opened: true, via: "dsh" };
}

/**
 * Hand a path to the OS file manager without going through DSH.
 *
 * `explorer.exe /select,<path>` opens the parent window with the item
 * highlighted; `open -R` is the same gesture on macOS, and Linux has no select,
 * so the containing directory is opened instead. Resolves `false` where the
 * platform has no opener or the spawn never started, which is what sends the
 * caller back to DSH.
 *
 * @param {string} path
 * @param {boolean} select
 * @returns {Promise<boolean>}
 */
/**
 * The path in the shape the OS launcher needs.
 *
 * Windows accepts forward slashes almost everywhere, but not in the two places
 * this module actually uses: the shell automation interface ignores `C:/x/y`,
 * and `explorer.exe` opens Documents instead of failing. The caller's own path
 * is left untouched — it is what the panel shows and what the tests compare —
 * so the conversion happens only on the way out.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} path
 * @returns {string}
 */
export function nativePath(platform, path) {
  const given = String(path ?? "");
  return platform === "win32" ? given.replace(/\//g, "\\") : given;
}

async function openNatively(path, select) {
  const platform = process.platform;
  const target = nativePath(platform, path);
  if (!target) return { ok: false, via: "none" };
  if (platform === "win32") return revealOnWindows(target, select);
  /** @type {string} */
  let command;
  /** @type {string[]} */
  let args;
  if (platform === "darwin") {
    command = "open";
    args = select ? ["-R", target] : [target];
  } else if (platform === "linux") {
    command = "xdg-open";
    args = [select ? dirname(target) : target];
  } else {
    return { ok: false, via: "none" };
  }
  const { spawn } = await import("node:child_process");
  const started = await new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
  return { ok: started, via: "native" };
}

/**
 * The Windows script that opens the folder, selects the file and brings the
 * window forward — then says whether a window is really there.
 *
 * `explorer.exe /select,<path>` returns 1 even when it does nothing, and the
 * shell may reuse a window on another desktop or leave it behind: the process
 * starting is not evidence a human saw anything. This goes through the shell
 * automation interface instead, which can be asked. `DSH_REVEAL_DIR` and
 * `DSH_REVEAL_NAME` carry the paths, so no path is ever spliced into code.
 */
export const WINDOWS_REVEAL_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$dir = $env:DSH_REVEAL_DIR
$name = $env:DSH_REVEAL_NAME
if (-not $dir) { '#R:none#'; exit 0 }
$url = ([uri]$dir).AbsoluteUri
$shell = New-Object -ComObject Shell.Application
$win = @($shell.Windows()) | Where-Object { $_.LocationURL -eq $url } | Select-Object -First 1
$fresh = $false
if (-not $win) {
  $shell.Explore($dir)
  $fresh = $true
  for ($i = 0; $i -lt 25 -and -not $win; $i++) {
    Start-Sleep -Milliseconds 60
    $win = @($shell.Windows()) | Where-Object { $_.LocationURL -eq $url } | Select-Object -First 1
  }
}
if (-not $win) { '#R:none#'; exit 0 }
if ($name) {
  $item = $win.Document.ParseName($name)
  if ($item) { $win.Document.SelectItem($item, 1) | Out-Null }
}
$state = 'behind'
try {
  Add-Type -Namespace Dsh -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
  $hwnd = [IntPtr]$win.HWND
  [Dsh.Win]::ShowWindow($hwnd, 9) | Out-Null
  [Dsh.Win]::BringWindowToTop($hwnd) | Out-Null
  [Dsh.Win]::SwitchToThisWindow($hwnd, $true)
  # A harmless ALT press makes this process the last one to receive input,
  # which is what Windows requires before it honours SetForegroundWindow.
  [Dsh.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [Dsh.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [Dsh.Win]::SetForegroundWindow($hwnd) | Out-Null
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 60
    if ([Dsh.Win]::GetForegroundWindow() -eq $hwnd) { $state = 'focused'; break }
  }
} catch {
  try { (New-Object -ComObject WScript.Shell).AppActivate($win.LocationName) | Out-Null } catch {}
  $state = 'activated'
}
if ($state -eq 'focused' -and $fresh) { '#R:opened#' }
elseif ($state -eq 'focused') { '#R:focused#' }
else { '#R:' + $state + '#' }
`;

/**
 * Windows: open + select + activate + verify.
 *
 * @param {string} target
 * @param {boolean} select
 * @returns {Promise<{ ok: boolean, via: string, detail?: string }>}
 */
async function revealOnWindows(target, select) {
  // First choice: the shell's own API. It opens *and* foregrounds the window in
  // one call (~15ms) because Explorer performs the reveal itself. `select` only
  // decides whether the item is highlighted, which the API does natively.
  const native = revealNatively(target);
  if (native?.ok) return { ok: true, via: "shell", detail: native.detail };
  const dir = select ? dirname(target) : target;
  const name = select ? basename(target) : "";
  // Fast path: the resident agent already has PowerShell and its compiled
  // P/Invokes loaded, so a request costs a line of stdin (~100ms) instead of a
  // process start plus `Add-Type` (~1.4s). Only if it fails do we pay for a
  // fresh process — a missing agent costs speed, never function.
  try {
    const state = await revealWithAgent(WINDOWS_REVEAL_SCRIPT, dir, name);
    return { ok: state !== "none", via: "powershell", detail: state };
  } catch {
    // Fall through to the one-shot path below.
  }
  const { spawn } = await import("node:child_process");
  const encoded = Buffer.from(WINDOWS_REVEAL_SCRIPT, "utf16le").toString("base64");
  const result = await new Promise((resolve) => {
    try {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, DSH_REVEAL_DIR: dir, DSH_REVEAL_NAME: name },
        },
      );
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.once("error", (error) => resolve({ ok: false, via: "powershell", detail: String(error?.message ?? error) }));
      child.once("close", () => {
        // The script ends with exactly one state word. `none` means it could
        // not even find a window; every other word means one is on screen,
        // with `focused`/`behind` telling us whether it reached the front.
        const state = /#R:(opened|focused|behind|activated|none)#/.exec(out)?.[1] ?? "none";
        resolve({ ok: state !== "none", via: "powershell", detail: state });
      });
    } catch (error) {
      resolve({ ok: false, via: "powershell", detail: String(error?.message ?? error) });
    }
  });
  if (result.ok) return result;
  // No shell automation (locked-down host, no PowerShell): the plain launcher is
  // all that is left, and it cannot be verified — say so in `via`.
  const { spawn: spawn2 } = await import("node:child_process");
  const started = await new Promise((resolve) => {
    try {
      const child = spawn2("explorer.exe", [select ? `/select,${target}` : target], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
  return started
    ? { ok: true, via: "explorer", detail: "unverified" }
    : { ok: false, via: "none", detail: result.detail };
}

/**
 * Where one session's log file lives on disk right now.
 *
 * The id is the only thing the client sends, and this is the lookup that turns
 * it into a path: a live session's log is in the snapshot the plugin already
 * built, and a trashed one's is in `<dataDir>/trash/<trashId>/` under the name
 * it had before it moved (the trash index records that origin). Anything the
 * plugin cannot place is refused rather than guessed at.
 *
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
export async function sessionLogFile(api, sessionId) {
  const id = String(sessionId ?? "");
  if (!id) throw codedError("bad-request", "sessionId is required");
  const snapshot = await api.reader.snapshot({});
  const live = (snapshot.sessions ?? []).find((session) => session?.id === id);
  if (typeof live?.logPath === "string" && live.logPath) return live.logPath;
  const entries = (await api.documents.trash.read())?.entries ?? {};
  const entry = entries[id];
  if (entry && typeof entry === "object") {
    const name = basename(String(entry.originalLogPath ?? ""));
    if (name) return join(trashTargetDir(api.paths, String(entry.trashId ?? "")), name);
  }
  throw codedError("session-not-found", `${id} has no session log to locate`);
}

/**
 * The session's log file as a plain path: no OS call, nothing opened.
 *
 * 复制文件路径 is the gesture that works everywhere — a path in the clipboard
 * can be pasted into an editor, a terminal or another machine's file dialog,
 * while an OS window can only open where the host is. Resolution is the same
 * one 定位 uses (including the trash index), so the copied path is the file
 * DSH actually wrote.
 *
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ path: string, name: string }>}
 */
/**
 * The directory a workspace points at, for 复制文件夹地址.
 *
 * Same resolution as `POST /workspaces/:id/reveal`, minus the OS call: the panel
 * copies text, and a path can be pasted anywhere a window cannot open.
 *
 * @param {any} api
 * @param {string} workspaceId
 * @returns {Promise<{ path: string, name: string }>}
 */
export async function workspaceDirPath(api, workspaceId) {
  const snapshot = await api.reader.snapshot({});
  const workspace = snapshot.registry?.workspaces?.get(workspaceId) ?? null;
  if (!workspace) throw codedError("workspace/not-found", `unknown workspace ${workspaceId}`);
  if (!workspace.path) throw codedError("bad-request", "这个工作区没有记录路径");
  const path = String(workspace.path);
  return { path, name: basename(path) || path };
}

export async function sessionLogPath(api, sessionId) {
  const path = await sessionLogFile(api, sessionId);
  return { path, name: basename(path) };
}

/**
 * 跳转至文件位置 for one session: select its log file in the file manager.
 *
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ path: string, opened: boolean }>}
 */
export async function revealSessionFile(api, sessionId) {
  const path = await sessionLogFile(api, sessionId);
  try {
    const result = await revealPath(api, path, { select: true });
    await traceReveal(api, { sessionId, path, ok: true, via: result.via });
    return { ...result, name: basename(path) };
  } catch (error) {
    await traceReveal(api, { sessionId, path, ok: false, error: `${error?.code ?? ""} ${error?.message ?? error}` });
    throw error;
  }
}

/**
 * 在文件管理器中显示 for one session: open the directory it belongs to.
 *
 * A session has two plausible "its directory": the working directory it ran in
 * (`cwd`, what the user was doing) and the folder holding its log. The cwd is
 * the one people mean when they ask to see a session's files; the log folder is
 * the fallback for a session that never recorded one.
 *
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ path: string, opened: boolean, via: "native" | "dsh" }>}
 */
export async function revealSessionDir(api, sessionId) {
  const id = String(sessionId ?? "");
  if (!id) throw codedError("bad-request", "sessionId is required");
  const snapshot = await api.reader.snapshot({});
  const session = (snapshot.sessions ?? []).find((item) => item?.id === id);
  const cwd = typeof session?.cwd === "string" ? session.cwd : "";
  const path = cwd || dirname(await sessionLogFile(api, id));
  try {
    const result = await revealPath(api, path, {});
    await traceReveal(api, { sessionId: id, path, ok: true, via: result.via, kind: "dir" });
    return result;
  } catch (error) {
    await traceReveal(api, { sessionId: id, path, ok: false, kind: "dir", error: `${error?.code ?? ""} ${error?.message ?? error}` });
    throw error;
  }
}

/**
 * Append one line per reveal attempt to `<dataDir>/logs/reveal.log`.
 *
 * 定位会话文件 fails in ways that leave no trace anywhere else: the click is a
 * POST from the panel, the failure surfaces as one line of hint text, and by the
 * time it is reported the toast is gone. A one-line audit trail is what turns
 * "点了没反应" into "the host tried this path and got this error".
 *
 * Never throws: logging is diagnostics, and a broken log directory must not be
 * the reason a reveal fails.
 *
 * @param {any} api
 * @param {{ sessionId?: string, path?: string, ok: boolean, via?: string, error?: string }} entry
 * @returns {Promise<void>}
 */
async function traceReveal(api, entry) {
  try {
    const { mkdir, appendFile } = await import("node:fs/promises");
    // `api.dataDir` is the root the plugin was opened on; `api.paths` is the
    // derived layout and has no `dataDir` key of its own — reading it there
    // threw, and the catch below swallowed every line.
    const root = api?.dataDir ?? api?.paths?.dataDir;
    if (!root) return;
    const dir = join(root, "logs");
    await mkdir(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${JSON.stringify({ platform: process.platform, ...entry })}\n`;
    await appendFile(join(dir, "reveal.log"), line, "utf8");
  } catch {
    /* diagnostics only */
  }
}

/**
 * Archive a session (视觉降权, not deletion — hard constraint 3).
 *
 * A session with running work refuses to be archived unless `stopActivity` is
 * set; the client shows a confirmation and retries with it.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {{ stopActivity?: boolean }} [options]
 * @returns {Promise<{ archivedSessionIds: string[] }>}
 */
export async function archiveSession(api, sessionId, options = {}) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.archiveSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot archive sessions");
  }
  const request = options.stopActivity === true ? { sessionId, stopActivity: true } : { sessionId };
  const result = await controller.archiveSession(request);
  refresh(api);
  return { archivedSessionIds: listOf(result?.archivedSessionIds) };
}

/**
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ archivedSessionIds: string[] }>}
 */
export async function unarchiveSession(api, sessionId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.unarchiveSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot unarchive sessions");
  }
  const result = await controller.unarchiveSession({ sessionId });
  refresh(api);
  return { archivedSessionIds: listOf(result?.archivedSessionIds) };
}

/**
 * Pin a session to the top of its list.
 *
 * DSH refuses to pin an archived session (`gateway/bad-request`), which is the
 * behaviour we surface rather than work around.
 *
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ pinnedSessionIds: string[] }>}
 */
export async function pinSession(api, sessionId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.pinSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot pin sessions");
  }
  const result = await controller.pinSession({ sessionId });
  refresh(api);
  return { pinnedSessionIds: listOf(result?.pinnedSessionIds) };
}

/**
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<{ pinnedSessionIds: string[] }>}
 */
export async function unpinSession(api, sessionId) {
  const controller = workspaceControllerOf(api.ctx);
  if (typeof controller.unpinSession !== "function") {
    throw codedError("capability-missing", "this DSH build cannot unpin sessions");
  }
  const result = await controller.unpinSession({ sessionId });
  refresh(api);
  return { pinnedSessionIds: listOf(result?.pinnedSessionIds) };
}

/**
 * Fork a session into a child that continues from a chosen event.
 *
 * Without `atSeq` DSH picks the latest completed turn — the same default the
 * official fork uses.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {number} [atSeq]
 * @returns {Promise<{ sessionId: string, parentSessionId: string }>}
 */
export async function forkSession(api, sessionId, atSeq) {
  const controller = sessionControllerOf(api.ctx);
  if (typeof controller.fork !== "function") {
    throw codedError("capability-missing", "this DSH build cannot fork sessions");
  }
  const request = Number.isSafeInteger(atSeq) ? { sessionId, atSeq } : { sessionId };
  const result = await controller.fork(request);
  const childId = String(result?.sessionId ?? "");
  if (!childId) throw codedError("fork-failed", "the host did not return a forked session id");
  refresh(api);
  return { sessionId: childId, parentSessionId: sessionId };
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function listOf(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
