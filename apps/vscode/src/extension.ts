// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- VS Code extension host glue around plain Node APIs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EMBED_HOST_PROTOCOL_VERSION,
  type EmbedFrameToHostMessage,
  type EmbedHostInitMessage,
  type EmbedHostStatusMessage,
  type EmbedHostStatusPhase,
  type EmbedHostWorkspace,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as vscode from "vscode";

import { AppServers } from "./appServers.ts";
import {
  PairingConsentError,
  type PairingDeps,
  type SecretStore,
  bearerSecretKey,
  ensureBearerToken,
  exchangePairingCredential,
  pairWithPastedCredential,
  pairingCredentialFromInput,
  validateBearerToken,
} from "./credentials.ts";
import {
  type DesktopServer,
  discoverDesktopServer,
  resolveT3Home,
  versionSkewWarning,
} from "./desktopServer.ts";
import { externalUrlToOpen, recordAuthFailure } from "./guards.ts";
import { findServerCli, mintPairingToken } from "./pairingCli.ts";
import { type PanelAction, WEBVIEW_TYPE, WorkspacePanel, isPanelState } from "./panel.ts";
import { type StaticServer, startStaticServer } from "./staticServer.ts";
import { workspaceLockFor } from "./workspaceLock.ts";

declare const __T3CODE_WEB_VERSION__: string;

const CONSENT_KEY = "t3code.pairingConsent";
/** SecretStorage keys holding bearer tokens, so Disconnect can find them without a server. */
const SECRET_KEYS_KEY = "t3code.bearerSecretKeys";
const portKey = (folderKey: string) => `t3code.port:${folderKey}`;

/** Resolved by the web app's own status messages, for the VS Code smoke test. */
export interface T3CodeTestApi {
  /**
   * Resolves on the folder's current or next status with `phase`; rejects if
   * the extension shows an error for that folder first.
   */
  waitForStatus(folderUri: string, phase: EmbedHostStatusPhase): Promise<EmbedHostStatusMessage>;
  setPairingConsent(granted: boolean): Thenable<void>;
}

interface Connection {
  readonly server: DesktopServer;
  readonly bearerToken: string;
}

type SessionEvent =
  | { readonly kind: "status"; readonly status: EmbedHostStatusMessage }
  | { readonly kind: "host-error"; readonly message: string };

/** A failure the panel shows as a page, with a way forward. */
class HostError extends Error {
  readonly title: string;
  readonly detail: string;
  readonly actions: ReadonlyArray<PanelAction>;

  constructor(title: string, detail: string, actions: ReadonlyArray<PanelAction>) {
    super(`${title} ${detail}`.trim());
    this.title = title;
    this.detail = detail;
    this.actions = actions;
  }
}

const RETRY: PanelAction = { id: "retry", label: "Retry" };
const PASTE_TOKEN: PanelAction = { id: "paste-token", label: "Paste Pairing Link…" };
const CONNECT: PanelAction = { id: "connect", label: "Connect" };

const ERROR_PHASES = new Set<EmbedHostStatusPhase>(["project-missing", "auth-failed", "error"]);

interface FolderSessionHandlers {
  readonly onFrameMessage: (session: FolderSession, message: EmbedFrameToHostMessage) => void;
  readonly onAction: (session: FolderSession, id: string) => void;
  readonly onDispose: (session: FolderSession) => void;
}

class FolderSession implements vscode.Disposable {
  readonly folder: vscode.WorkspaceFolder;
  readonly view: WorkspacePanel;
  private readonly handlers: FolderSessionHandlers;
  /** Bumped by every start; only the latest start may update the page. */
  startAttempt = 0;
  lastStatus: EmbedHostStatusMessage | null = null;
  hostError: string | null = null;
  /** The bearer token in the last init, so an auth failure never gets it back. */
  sentToken: string | null = null;
  authFailures: ReadonlyArray<number> = [];
  private disposed = false;

  constructor(
    folder: vscode.WorkspaceFolder,
    panel: vscode.WebviewPanel,
    handlers: FolderSessionHandlers,
  ) {
    this.folder = folder;
    this.handlers = handlers;
    this.view = new WorkspacePanel(
      panel,
      { folderUri: folder.uri.toString() },
      {
        onFrameMessage: (message) => handlers.onFrameMessage(this, message),
        onAction: (id) => handlers.onAction(this, id),
      },
    );
    panel.onDidDispose(() => this.dispose());
  }

  get key() {
    return this.folder.uri.toString();
  }

  get isDisposed() {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.view.dispose();
    this.view.panel.dispose();
    this.handlers.onDispose(this);
  }
}

class T3CodeController implements vscode.Disposable {
  private readonly sessions = new Map<string, FolderSession>();
  private readonly listeners = new Set<(key: string, event: SessionEvent) => void>();
  private readonly warnedVersions = new Set<string>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly platform = HostProcessPlatform.defaultValue();
  private readonly appServers = new AppServers((key) => this.startStaticServer(key));
  private connection: Connection | null = null;
  private pendingConnection: {
    readonly interactive: boolean;
    readonly promise: Promise<Connection>;
  } | null = null;
  /** Bumped by Disconnect so an attempt still in flight can't reconnect afterwards. */
  private connectionEpoch = 0;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.statusItem = vscode.window.createStatusBarItem(
      "t3code.status",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusItem.name = "T3 Code";
    this.statusItem.command = "t3code.open";
    this.updateStatusItem();
  }

  // ---- Entry points ----

  async open(target?: vscode.Uri): Promise<void> {
    if (!this.ensureLocalWindow()) return;
    const folder = await this.pickFolder(target);
    if (!folder) return;

    const existing = this.sessions.get(folder.uri.toString());
    if (existing) {
      existing.view.panel.reveal();
      if (existing.hostError !== null) await this.start(existing, { interactive: true });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      WEBVIEW_TYPE,
      this.panelTitle(folder),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    await this.start(this.createSession(folder, panel), { interactive: true });
  }

  /** Restores a panel VS Code kept from an earlier session. */
  async restore(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const folder = isPanelState(state)
      ? vscode.workspace.workspaceFolders?.find((item) => item.uri.toString() === state.folderUri)
      : undefined;
    if (!folder || vscode.env.remoteName || this.sessions.has(folder.uri.toString())) {
      panel.dispose();
      return;
    }
    panel.title = this.panelTitle(folder);
    // No consent prompt on startup; a restored panel offers a Connect button instead.
    await this.start(this.createSession(folder, panel), { interactive: false });
  }

  async connect(): Promise<void> {
    if (!this.ensureLocalWindow()) return;
    const choice = await vscode.window.showQuickPick(
      [
        {
          id: "auto",
          label: "Pair Automatically",
          detail: "Uses the T3 Code desktop app's command-line tool on this Mac.",
        },
        {
          id: "paste",
          label: "Paste a Pairing Link or Token",
          detail: "Use a pairing link created in the T3 Code desktop app.",
        },
      ],
      { title: "Connect T3 Code to the desktop app" },
    );
    if (!choice) return;
    if (choice.id === "paste") {
      await this.pasteToken();
      return;
    }
    try {
      this.connection = null;
      await this.getConnection({ interactive: true });
      void vscode.window.showInformationMessage("T3 Code is connected to the desktop app.");
      await this.restartSessions((session) => session.hostError !== null);
    } catch (error) {
      if (error instanceof PairingConsentError) return;
      void vscode.window.showErrorMessage(errorText(error));
    }
  }

  async disconnect(): Promise<void> {
    for (const session of this.sessions.values()) session.dispose();
    this.connectionEpoch += 1;
    this.connection = null;
    this.pendingConnection = null;
    const { globalState, secrets } = this.context;
    const keys = globalState.get<ReadonlyArray<string>>(SECRET_KEYS_KEY) ?? [];
    await Promise.all(keys.map((key) => secrets.delete(key)));
    await globalState.update(SECRET_KEYS_KEY, undefined);
    await globalState.update(CONSENT_KEY, undefined);
    void vscode.window.showInformationMessage(
      "T3 Code is disconnected. VS Code will ask before pairing again. To end VS Code's session on the server, revoke it in the desktop app's settings.",
    );
  }

  async reload(): Promise<void> {
    if (this.sessions.size === 0) {
      await this.open();
      return;
    }
    const active = [...this.sessions.values()].filter((session) => session.view.panel.active);
    this.connection = null;
    await this.restartSessions((session) => active.length === 0 || active.includes(session));
  }

  // ---- Sessions ----

  private createSession(folder: vscode.WorkspaceFolder, panel: vscode.WebviewPanel) {
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "resources", "icon.png");
    const session = new FolderSession(folder, panel, {
      onFrameMessage: (target, message) => void this.onFrameMessage(target, message),
      onAction: (target, id) => void this.onAction(target, id),
      onDispose: (target) => {
        if (this.sessions.get(target.key) === target) this.sessions.delete(target.key);
        void this.appServers.close(target.key);
        this.updateStatusItem();
      },
    });
    this.sessions.set(session.key, session);
    this.updateStatusItem();
    return session;
  }

  private async start(
    session: FolderSession,
    options: { readonly interactive: boolean; readonly rejectedToken?: string },
  ): Promise<void> {
    const attempt = ++session.startAttempt;
    const isCurrent = () => !session.isDisposed && session.startAttempt === attempt;
    session.hostError = null;
    session.lastStatus = null;
    session.view.showMessage("Connecting to T3 Code…");
    this.updateStatusItem();
    try {
      await this.getConnection(options);
      if (!isCurrent()) return;
      const server = await this.appServers.get(session.key);
      if (!isCurrent()) return;
      session.view.showApp(server.origin);
    } catch (error) {
      if (!isCurrent()) return;
      const failure = toHostError(error);
      session.hostError = failure.message;
      session.view.showMessage(failure.title, failure.detail, failure.actions);
      this.emit(session, { kind: "host-error", message: failure.message });
      this.updateStatusItem();
    }
  }

  private async restartSessions(filter: (session: FolderSession) => boolean) {
    await Promise.all(
      [...this.sessions.values()]
        .filter(filter)
        .map((session) => this.start(session, { interactive: false })),
    );
  }

  private async startStaticServer(folderKey: string): Promise<StaticServer> {
    const root = vscode.Uri.joinPath(this.context.extensionUri, "dist", "web").fsPath;
    if (!NodeFS.existsSync(NodePath.join(root, "index.html"))) {
      throw new HostError(
        "This build of the extension is missing the T3 Code web app.",
        "Rebuild the extension with its web app included.",
        [],
      );
    }
    const preferredPort = this.context.globalState.get<number>(portKey(folderKey));
    const server = await startStaticServer({
      root,
      ...(preferredPort ? { preferredPort } : {}),
    });
    // Keeping the port keeps the app's origin, and with it this folder's drafts and UI state.
    if (server.port !== preferredPort) {
      await this.context.globalState.update(portKey(folderKey), server.port);
    }
    return server;
  }

  private async onFrameMessage(session: FolderSession, message: EmbedFrameToHostMessage) {
    if (session.isDisposed) return;
    switch (message.type) {
      case "t3code/hello":
        await this.sendInit(session);
        return;
      case "t3code/status":
        session.lastStatus = message;
        this.emit(session, { kind: "status", status: message });
        this.updateStatusItem();
        if (message.phase === "auth-failed") await this.recoverFromAuthFailure(session);
        return;
      case "t3code/open-external": {
        const url = externalUrlToOpen(message.url);
        if (url !== null) await vscode.env.openExternal(vscode.Uri.parse(url, true));
        return;
      }
    }
  }

  private async sendInit(session: FolderSession) {
    const workspacePlatform = this.workspacePlatform();
    if (workspacePlatform === null) return;
    let connection: Connection;
    try {
      connection = this.connection ?? (await this.getConnection({ interactive: false }));
    } catch {
      await this.start(session, { interactive: false });
      return;
    }
    const { server, bearerToken } = connection;
    const init: EmbedHostInitMessage = {
      version: EMBED_HOST_PROTOCOL_VERSION,
      type: "t3code/init",
      workspace: workspaceLockFor({
        fsPath: session.folder.uri.fsPath,
        name: session.folder.name,
        platform: workspacePlatform,
      }),
      environment: {
        environmentId: server.environmentId,
        label: server.label,
        httpBaseUrl: server.httpBaseUrl,
        wsBaseUrl: server.wsBaseUrl,
        bearerToken,
      },
    };
    session.sentToken = bearerToken;
    await session.view.postToFrame(init);
  }

  /** Pairs again (silently once consent is on record) and reloads the app. */
  private async recoverFromAuthFailure(session: FolderSession) {
    const { recent, exhausted } = recordAuthFailure(session.authFailures, Date.now());
    session.authFailures = recent;
    if (exhausted) {
      session.hostError = "T3 Code keeps rejecting VS Code's session.";
      session.view.showMessage(
        "T3 Code keeps rejecting VS Code's session.",
        "Try connecting again, or paste a pairing link from the desktop app.",
        [CONNECT, PASTE_TOKEN],
      );
      this.emit(session, { kind: "host-error", message: session.hostError });
      this.updateStatusItem();
      return;
    }
    const rejectedToken = session.sentToken;
    if (this.connection?.bearerToken === rejectedToken) this.connection = null;
    await this.start(session, {
      interactive: false,
      ...(rejectedToken ? { rejectedToken } : {}),
    });
  }

  private async onAction(session: FolderSession, id: string) {
    session.authFailures = [];
    if (id === "retry") {
      await this.start(session, { interactive: false });
    } else if (id === "connect") {
      // Pair again rather than reuse a token the app may have just rejected.
      const rejectedToken = session.sentToken;
      if (this.connection?.bearerToken === rejectedToken) this.connection = null;
      await this.start(session, { interactive: true, ...(rejectedToken ? { rejectedToken } : {}) });
    } else if (id === "paste-token") {
      await this.pasteToken();
    }
  }

  private emit(session: FolderSession, event: SessionEvent) {
    for (const listener of this.listeners) listener(session.key, event);
  }

  // ---- Connection ----

  private t3Home() {
    return resolveT3Home({
      setting: vscode.workspace.getConfiguration("t3code").get<string>("homeDir"),
      envHome: process.env.T3CODE_HOME,
      homeDirectory: NodeOS.homedir(),
    });
  }

  private async discover(): Promise<DesktopServer> {
    const discovery = await discoverDesktopServer(this.t3Home());
    switch (discovery._tag) {
      case "Found":
        return discovery.server;
      case "NotRunning":
        throw new HostError(
          "The T3 Code desktop app isn't running.",
          `Open the desktop app, then retry. (Looked in ${discovery.home}.)`,
          [RETRY],
        );
      case "Unavailable":
        throw new HostError("Can't connect to T3 Code.", discovery.message, [RETRY]);
    }
  }

  /**
   * One shared connection per window; overlapping callers share one attempt.
   * A silent attempt can't ask for consent and may return a token a caller
   * just saw rejected, so such callers start their own attempt after it.
   */
  private getConnection(options: {
    readonly interactive: boolean;
    readonly rejectedToken?: string;
  }): Promise<Connection> {
    if (this.connection && this.connection.bearerToken !== options.rejectedToken) {
      return Promise.resolve(this.connection);
    }
    const pending = this.pendingConnection;
    if (pending) {
      if ((pending.interactive || !options.interactive) && !options.rejectedToken) {
        return pending.promise;
      }
      const retry = () => this.getConnection(options);
      return pending.promise.then(retry, retry);
    }
    const epoch = this.connectionEpoch;
    const promise = (async () => {
      const server = await this.discover();
      this.warnAboutVersionSkew(server);
      const bearerToken = await ensureBearerToken(
        server.environmentId,
        this.pairingDeps(server),
        options,
      );
      if (epoch !== this.connectionEpoch) {
        await this.context.secrets.delete(bearerSecretKey(server.environmentId));
        throw new PairingConsentError("T3 Code was disconnected.");
      }
      this.connection = { server, bearerToken };
      return this.connection;
    })().finally(() => {
      if (this.pendingConnection?.promise === promise) this.pendingConnection = null;
    });
    this.pendingConnection = { interactive: options.interactive, promise };
    return promise;
  }

  /** SecretStorage that remembers which keys it wrote, for Disconnect. */
  private trackedSecrets(): SecretStore {
    const { globalState, secrets } = this.context;
    return {
      get: (key) => secrets.get(key),
      store: async (key, value) => {
        const keys = globalState.get<ReadonlyArray<string>>(SECRET_KEYS_KEY) ?? [];
        if (!keys.includes(key)) await globalState.update(SECRET_KEYS_KEY, [...keys, key]);
        await secrets.store(key, value);
      },
      delete: (key) => secrets.delete(key),
    };
  }

  private pairingDeps(server: DesktopServer): PairingDeps {
    const config = vscode.workspace.getConfiguration("t3code");
    return {
      secrets: this.trackedSecrets(),
      hasConsent: () => this.context.globalState.get<boolean>(CONSENT_KEY) === true,
      recordConsent: () => this.context.globalState.update(CONSENT_KEY, true),
      askConsent: async () => {
        const allow = "Allow";
        const choice = await vscode.window.showInformationMessage(
          "Connect VS Code to the T3 Code desktop app?",
          {
            modal: true,
            detail:
              "VS Code will use the desktop app's command-line tool to create its own sign-in, the same way you would pair another device. It only asks once; T3 Code: Disconnect undoes it.",
          },
          allow,
        );
        return choice === allow;
      },
      mintPairingToken: async () =>
        mintPairingToken({
          cli: await findServerCli({
            serverCommand: config.get<ReadonlyArray<string>>("serverCommand") ?? [],
            desktopAppPath: config.get<string>("desktopAppPath"),
            serverPid: server.pid,
            serverVersion: server.serverVersion,
            home: server.home,
            homeDirectory: NodeOS.homedir(),
            platform: this.platform,
          }),
          home: server.home,
        }),
      exchange: (credential) =>
        exchangePairingCredential({
          httpBaseUrl: server.httpBaseUrl,
          credential,
          platform: this.platform,
        }),
      validate: (bearerToken) =>
        validateBearerToken({ httpBaseUrl: server.httpBaseUrl, bearerToken }),
    };
  }

  private async pasteToken(): Promise<void> {
    let server: DesktopServer;
    try {
      server = await this.discover();
    } catch (error) {
      void vscode.window.showErrorMessage(errorText(error));
      return;
    }
    const input = await vscode.window.showInputBox({
      title: "Connect T3 Code to the desktop app",
      prompt: "Paste a pairing link or token from the T3 Code desktop app.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 || pairingCredentialFromInput(value) !== null
          ? null
          : "That doesn't look like a pairing link or token.",
    });
    const credential = input === undefined ? null : pairingCredentialFromInput(input);
    if (credential === null) return;
    try {
      const bearerToken = await pairWithPastedCredential(
        server.environmentId,
        credential,
        this.pairingDeps(server),
      );
      this.connection = { server, bearerToken };
      void vscode.window.showInformationMessage("T3 Code is connected to the desktop app.");
      await this.restartSessions(() => true);
    } catch (error) {
      void vscode.window.showErrorMessage(errorText(error));
    }
  }

  private warnAboutVersionSkew(server: DesktopServer) {
    const warning = versionSkewWarning(server.serverVersion, __T3CODE_WEB_VERSION__);
    if (warning === null || this.warnedVersions.has(server.serverVersion)) return;
    this.warnedVersions.add(server.serverVersion);
    void vscode.window.showWarningMessage(warning);
  }

  // ---- Window state ----

  private ensureLocalWindow(): boolean {
    if (vscode.env.remoteName) {
      void vscode.window.showErrorMessage(
        "T3 Code works in local VS Code windows only for now. Open this folder in a local window to use it.",
      );
      return false;
    }
    return this.workspacePlatform() !== null;
  }

  private workspacePlatform(): EmbedHostWorkspace["platform"] | null {
    if (this.platform === "darwin" || this.platform === "linux" || this.platform === "win32") {
      return this.platform;
    }
    void vscode.window.showErrorMessage(`T3 Code doesn't support ${this.platform}.`);
    return null;
  }

  private fileFolders(): ReadonlyArray<vscode.WorkspaceFolder> {
    return (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === "file",
    );
  }

  private async pickFolder(target?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = this.fileFolders();
    if (target) {
      const folder = vscode.workspace.getWorkspaceFolder(target);
      if (folder && folders.includes(folder)) return folder;
    }
    if (folders.length === 0) {
      void vscode.window.showInformationMessage("Open a folder to use T3 Code.");
      return undefined;
    }
    if (folders.length === 1) return folders[0];
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { title: "Open T3 Code for which folder?" },
    );
    return picked?.folder;
  }

  private panelTitle(folder: vscode.WorkspaceFolder) {
    return `T3 Code: ${folder.name}`;
  }

  onFoldersChanged(event: vscode.WorkspaceFoldersChangeEvent) {
    for (const removed of event.removed) this.sessions.get(removed.uri.toString())?.dispose();
    this.updateStatusItem();
  }

  private updateStatusItem() {
    if (vscode.env.remoteName || this.fileFolders().length === 0) {
      this.statusItem.hide();
      return;
    }
    const sessions = [...this.sessions.values()];
    const troubled = sessions.filter(
      (session) =>
        session.hostError !== null ||
        (session.lastStatus !== null && ERROR_PHASES.has(session.lastStatus.phase)),
    );
    this.statusItem.text =
      troubled.length > 0 ? "$(warning) T3 Code" : "$(comment-discussion) T3 Code";
    this.statusItem.backgroundColor =
      troubled.length > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const lines = sessions.map(
      (session) =>
        `${session.folder.name}: ${session.hostError ?? session.lastStatus?.message ?? session.lastStatus?.phase ?? "connecting"}`,
    );
    this.statusItem.tooltip = ["Open T3 Code for this folder", ...lines].join("\n");
    this.statusItem.show();
  }

  // ---- Test API ----

  testApi(): T3CodeTestApi {
    return {
      waitForStatus: (folderUri, phase) =>
        new Promise((resolve, reject) => {
          const current = this.sessions.get(folderUri)?.lastStatus;
          if (current?.phase === phase) {
            resolve(current);
            return;
          }
          const listener = (key: string, event: SessionEvent) => {
            if (key !== folderUri) return;
            if (event.kind === "host-error") {
              this.listeners.delete(listener);
              reject(new Error(event.message));
            } else if (event.status.phase === phase) {
              this.listeners.delete(listener);
              resolve(event.status);
            }
          };
          this.listeners.add(listener);
        }),
      setPairingConsent: (granted) =>
        this.context.globalState.update(CONSENT_KEY, granted ? true : undefined),
    };
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    void this.appServers.closeAll();
    this.statusItem.dispose();
    this.listeners.clear();
  }
}

function toHostError(error: unknown): HostError {
  if (error instanceof HostError) return error;
  if (error instanceof PairingConsentError) {
    return new HostError(
      "Connect VS Code to T3 Code.",
      "VS Code needs your permission to pair with the T3 Code desktop app.",
      [CONNECT, PASTE_TOKEN],
    );
  }
  return new HostError("Couldn't connect to T3 Code.", errorText(error), [RETRY, PASTE_TOKEN]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function activate(context: vscode.ExtensionContext): T3CodeTestApi | undefined {
  const controller = new T3CodeController(context);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("t3code.open", (target?: unknown) =>
      controller.open(target instanceof vscode.Uri ? target : undefined),
    ),
    vscode.commands.registerCommand("t3code.connect", () => controller.connect()),
    vscode.commands.registerCommand("t3code.disconnect", () => controller.disconnect()),
    vscode.commands.registerCommand("t3code.reload", () => controller.reload()),
    vscode.window.registerWebviewPanelSerializer(WEBVIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => controller.restore(panel, state),
    }),
    // The view only hosts its welcome content (the Open button); it never has items.
    vscode.window.registerTreeDataProvider<vscode.TreeItem>("t3code.welcome", {
      getChildren: () => [],
      getTreeItem: (item) => item,
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => controller.onFoldersChanged(event)),
  );
  return context.extensionMode === vscode.ExtensionMode.Production
    ? undefined
    : controller.testApi();
}

export function deactivate(): void {}
