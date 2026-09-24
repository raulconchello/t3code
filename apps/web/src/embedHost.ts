import {
  EMBED_HOST_PROTOCOL_VERSION,
  type EmbedFrameToHostMessage,
  type EmbedHostInitMessage,
  type EmbedHostStatusMessage,
  type EmbedHostWorkspace,
  isEmbedHostToFrameMessage,
} from "@t3tools/contracts";

/**
 * Embedded builds run inside an iframe owned by a host page, such as the VS
 * Code extension's webview. The host supplies the environment connection and
 * the workspace the app is locked to; see `connectEmbedHost`.
 */
export const EMBED_HOST_BUILD = import.meta.env.VITE_T3CODE_EMBED_HOST === "vscode";

interface EmbedHostConnection {
  readonly init: EmbedHostInitMessage;
  readonly host: Window;
  /** Replies go to the origin the init came from. */
  readonly origin: string;
}

let connection: EmbedHostConnection | null = null;

/** The host's init message, or null outside an embedded build. */
export function readEmbedHost(): EmbedHostInitMessage | null {
  return connection?.init ?? null;
}

/**
 * Says hello to the parent window and resolves with the first init it sends
 * back. Messages from anything but the parent window are ignored. A later init
 * from the same origin that differs from the first one reloads the app, so the
 * host can swap credentials or the workspace; an identical one is ignored. An
 * init from an opaque ("null") origin fails the start: replies could not be
 * addressed to it without sending them to any origin.
 */
export function connectEmbedHost(target: Window = window): Promise<EmbedHostInitMessage> {
  if (connection !== null) return Promise.resolve(connection.init);
  if (target.parent === target) {
    return Promise.reject(new Error("This build of T3 Code only runs inside its host app."));
  }

  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target.parent || !isEmbedHostToFrameMessage(event.data)) return;
      if (connection === null) {
        if (event.origin === "null") {
          target.removeEventListener("message", onMessage);
          reject(new Error("The host page has an opaque origin, so T3 Code cannot answer it."));
          return;
        }
        connection = { init: event.data, host: target.parent, origin: event.origin };
        installExternalLinkHandler(target);
        installHostShortcutForwarding(target, event.data.workspace.platform);
        resolve(event.data);
        return;
      }
      if (event.origin !== connection.origin) return;
      if (JSON.stringify(event.data) === JSON.stringify(connection.init)) return;
      target.location.reload();
    };
    target.addEventListener("message", onMessage);
    // The hello carries nothing private and the host's origin is not known yet.
    target.parent.postMessage(
      {
        version: EMBED_HOST_PROTOCOL_VERSION,
        type: "t3code/hello",
      } satisfies EmbedFrameToHostMessage,
      "*",
    );
  });
}

/**
 * Sends a message to the host, addressed to the origin its init came from. A
 * no-op until then. A failed send is logged, never thrown into the caller.
 */
export function postToEmbedHost(message: EmbedFrameToHostMessage): void {
  if (connection === null) return;
  try {
    connection.host.postMessage(message, connection.origin);
  } catch (error) {
    console.warn("T3 Code could not send a message to its host page.", error);
  }
}

export function reportEmbedHostStatus(
  status: Omit<EmbedHostStatusMessage, "version" | "type">,
): void {
  postToEmbedHost({ version: EMBED_HOST_PROTOCOL_VERSION, type: "t3code/status", ...status });
}

export function openExternalInEmbedHost(url: string): void {
  postToEmbedHost({ version: EMBED_HOST_PROTOCOL_VERSION, type: "t3code/open-external", url });
}

function externalLinkUrl(anchor: HTMLAnchorElement, pageOrigin: string): string | null {
  if (anchor.target !== "_blank") return null;
  try {
    const url = new URL(anchor.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === pageOrigin ? null : url.toString();
  } catch {
    return null;
  }
}

/**
 * The host page cannot open new windows for the frame, so external `_blank`
 * links go to the host instead. It listens in the bubble phase on the window,
 * after the app's own handlers, and skips clicks the app already handled; this
 * is the role the desktop shell's window-open handler plays.
 */
function installExternalLinkHandler(target: Window): void {
  const handle = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.type === "auxclick" && event.button !== 1)) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = externalLinkUrl(anchor, target.location.origin);
    if (url === null) return;
    event.preventDefault();
    openExternalInEmbedHost(url);
  };
  target.addEventListener("click", handle);
  target.addEventListener("auxclick", handle);
}

const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/;
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "CapsLock"]);
/** Select all, copy, cut, paste, undo and redo (plus Shift+Z), which the frame keeps. */
const EDITING_KEYS = new Set(["a", "c", "v", "x", "y", "z"]);
/** Caret movement and deletion keep their native meaning with any modifier. */
const NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
]);

type ShortcutKeys = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "altKey"
  | "ctrlKey"
  | "metaKey"
  | "shiftKey"
  | "isComposing"
  | "getModifierState"
>;

const editingLetter = (event: ShortcutKeys) => {
  const fromCode = /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase();
  const fromKey = event.key.length === 1 ? event.key.toLowerCase() : undefined;
  return [fromCode, fromKey].find((letter) => letter !== undefined && EDITING_KEYS.has(letter));
};

/**
 * Whether a keydown is a shortcut for the host rather than input for the app:
 * a function key, or a key pressed with Ctrl (or Cmd on macOS). Text input
 * stays in the frame: plain typing, IME composition, AltGr characters (which
 * Windows and Linux report as Ctrl+Alt), caret movement and deletion, and the
 * native editing shortcuts.
 */
export function isHostShortcut(
  event: ShortcutKeys,
  platform: EmbedHostWorkspace["platform"],
): boolean {
  if (event.isComposing || event.getModifierState("AltGraph")) return false;
  if (NAVIGATION_KEYS.has(event.key)) return false;
  if (FUNCTION_KEY.test(event.key)) return true;
  const command = event.ctrlKey || (platform === "darwin" && event.metaKey);
  if (!command || MODIFIER_KEYS.has(event.key)) return false;
  const printable = event.key.length === 1;
  if (platform !== "darwin" && event.ctrlKey && event.altKey && printable) return false;
  const letter = editingLetter(event);
  if (letter === undefined || event.altKey) return true;
  return event.shiftKey && letter !== "z";
}

/**
 * Keydowns don't cross frames, so a host shortcut pressed while the app has
 * focus (the VS Code command palette, closing a tab) would reach only the app.
 * Once dispatch ends, a shortcut the app didn't handle goes to the host, which
 * replays it on its own page. The check waits for dispatch to finish because
 * many of the app's own shortcut listeners sit on the window after this one.
 */
function installHostShortcutForwarding(
  target: Window,
  platform: EmbedHostWorkspace["platform"],
): void {
  target.addEventListener("keydown", (event) => {
    if (!isHostShortcut(event, platform)) return;
    setTimeout(() => {
      if (event.defaultPrevented) return;
      postToEmbedHost({
        version: EMBED_HOST_PROTOCOL_VERSION,
        type: "t3code/keydown",
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
      });
    }, 0);
  });
}
