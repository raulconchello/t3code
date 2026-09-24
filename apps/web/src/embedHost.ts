import {
  EMBED_HOST_PROTOCOL_VERSION,
  type EmbedFrameToHostMessage,
  type EmbedHostInitMessage,
  type EmbedHostStatusMessage,
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
  /** Replies go to the origin the init came from; see `hostTargetOrigin`. */
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
 * host can swap credentials or the workspace; an identical one is ignored.
 */
export function connectEmbedHost(target: Window = window): Promise<EmbedHostInitMessage> {
  if (connection !== null) return Promise.resolve(connection.init);
  if (target.parent === target) {
    return Promise.reject(new Error("This build of T3 Code only runs inside its host app."));
  }

  return new Promise((resolve) => {
    target.addEventListener("message", (event) => {
      if (event.source !== target.parent || !isEmbedHostToFrameMessage(event.data)) return;
      if (connection === null) {
        connection = { init: event.data, host: target.parent, origin: event.origin };
        installExternalLinkHandler(target);
        resolve(event.data);
        return;
      }
      if (event.origin !== connection.origin) return;
      if (JSON.stringify(event.data) === JSON.stringify(connection.init)) return;
      target.location.reload();
    });
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

// An opaque origin ("null") cannot be targeted, so fall back to any origin.
function hostTargetOrigin(origin: string): string {
  return origin === "null" ? "*" : origin;
}

/** Sends a message to the host. A no-op until the host has sent its init. */
export function postToEmbedHost(message: EmbedFrameToHostMessage): void {
  connection?.host.postMessage(message, hostTargetOrigin(connection.origin));
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
