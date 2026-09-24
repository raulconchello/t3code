// @effect-diagnostics nodeBuiltinImport:off -- VS Code webview glue; nonces come from node:crypto.
import * as NodeCrypto from "node:crypto";

import {
  type EmbedFrameToHostMessage,
  type EmbedHostToFrameMessage,
  isEmbedFrameToHostMessage,
} from "@t3tools/contracts";
import * as vscode from "vscode";

export const WEBVIEW_TYPE = "t3code.workspace";

/** Persisted by the webview itself so the serializer can find the folder again. */
export interface PanelState {
  readonly folderUri: string;
}

export const isPanelState = (value: unknown): value is PanelState =>
  typeof value === "object" &&
  value !== null &&
  "folderUri" in value &&
  typeof value.folderUri === "string";

export interface PanelAction {
  readonly id: string;
  readonly label: string;
}

/** Messages between the extension and the relay script in the webview. */
type RelayToExtension =
  | { readonly kind: "t3code-host/from-frame"; readonly message: unknown }
  | { readonly kind: "t3code-host/action"; readonly id: string };

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) =>
    char === "&"
      ? "&amp;"
      : char === "<"
        ? "&lt;"
        : char === ">"
          ? "&gt;"
          : char === '"'
            ? "&quot;"
            : "&#39;",
  );

/** Inline JSON that cannot close the surrounding script element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

const page = (input: {
  readonly nonce: string;
  readonly frameOrigin: string | null;
  readonly body: string;
  readonly script: string;
}) => {
  const csp = [
    "default-src 'none'",
    ...(input.frameOrigin ? [`frame-src ${input.frameOrigin}`] : []),
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${input.nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
.message { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
.message h2 { margin: 0; font-size: 1.2em; font-weight: 600; }
.message p { margin: 0; max-width: 36em; color: var(--vscode-descriptionForeground); }
.actions { display: flex; gap: 8px; }
button { font: inherit; padding: 4px 12px; border: 0; border-radius: 2px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
</style>
</head>
<body>
${input.body}
<script nonce="${input.nonce}">
${input.script}
</script>
</body>
</html>`;
};

/**
 * The app page: a full-size iframe on the local static server plus a relay.
 * Frame messages are forwarded only from that iframe and its exact origin;
 * extension messages are forwarded only to that origin.
 */
function renderAppHtml(input: {
  readonly nonce: string;
  readonly appOrigin: string;
  readonly state: PanelState;
}): string {
  return page({
    nonce: input.nonce,
    frameOrigin: input.appOrigin,
    body: `<iframe id="app" src="${escapeHtml(`${input.appOrigin}/`)}" allow="clipboard-read; clipboard-write"></iframe>`,
    script: `(() => {
  const vscode = acquireVsCodeApi();
  const appOrigin = ${scriptJson(input.appOrigin)};
  const frame = document.getElementById("app");
  vscode.setState(${scriptJson(input.state)});
  window.addEventListener("message", (event) => {
    if (event.source === frame.contentWindow) {
      if (event.origin === appOrigin) {
        vscode.postMessage({ kind: "t3code-host/from-frame", message: event.data });
      }
      return;
    }
    const data = event.data;
    if (event.origin === window.origin && data && data.kind === "t3code-host/to-frame") {
      frame.contentWindow?.postMessage(data.message, appOrigin);
    }
  });
})();`,
  });
}

/** A status or error page with optional action buttons, shown instead of the app. */
function renderMessageHtml(input: {
  readonly nonce: string;
  readonly state: PanelState;
  readonly title: string;
  readonly detail?: string;
  readonly actions?: ReadonlyArray<PanelAction>;
}): string {
  const actions = input.actions ?? [];
  const buttons = actions
    .map(
      (action, index) =>
        `<button data-action="${escapeHtml(action.id)}"${index > 0 ? ' class="secondary"' : ""}>${escapeHtml(action.label)}</button>`,
    )
    .join("");
  return page({
    nonce: input.nonce,
    frameOrigin: null,
    body: `<div class="message" role="status">
<h2>${escapeHtml(input.title)}</h2>
${input.detail ? `<p>${escapeHtml(input.detail)}</p>` : ""}
${buttons ? `<div class="actions">${buttons}</div>` : ""}
</div>`,
    script: `(() => {
  const vscode = acquireVsCodeApi();
  vscode.setState(${scriptJson(input.state)});
  for (const button of document.querySelectorAll("button[data-action]")) {
    button.addEventListener("click", () => {
      vscode.postMessage({ kind: "t3code-host/action", id: button.dataset.action });
    });
  }
})();`,
  });
}

const isRelayMessage = (value: unknown): value is RelayToExtension =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value.kind === "t3code-host/from-frame" ||
    (value.kind === "t3code-host/action" && "id" in value && typeof value.id === "string"));

/** One editor tab showing T3 Code for one folder. */
export class WorkspacePanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private readonly state: PanelState;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    panel: vscode.WebviewPanel,
    state: PanelState,
    handlers: {
      readonly onFrameMessage: (message: EmbedFrameToHostMessage) => void;
      readonly onAction: (id: string) => void;
    },
  ) {
    this.panel = panel;
    this.state = state;
    panel.webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [],
    };
    this.disposables.push(
      panel.webview.onDidReceiveMessage((value: unknown) => {
        if (!isRelayMessage(value)) return;
        if (value.kind === "t3code-host/action") {
          handlers.onAction(value.id);
        } else if (isEmbedFrameToHostMessage(value.message)) {
          handlers.onFrameMessage(value.message);
        }
      }),
    );
  }

  showApp(appOrigin: string): void {
    this.panel.webview.html = renderAppHtml({ nonce: newNonce(), appOrigin, state: this.state });
  }

  showMessage(title: string, detail?: string, actions?: ReadonlyArray<PanelAction>): void {
    this.panel.webview.html = renderMessageHtml({
      nonce: newNonce(),
      state: this.state,
      title,
      ...(detail ? { detail } : {}),
      ...(actions ? { actions } : {}),
    });
  }

  postToFrame(message: EmbedHostToFrameMessage): Thenable<boolean> {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- The webview relay forwards to the app's exact origin.
    return this.panel.webview.postMessage({ kind: "t3code-host/to-frame", message });
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

const newNonce = () => NodeCrypto.randomBytes(16).toString("base64url");
