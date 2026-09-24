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
