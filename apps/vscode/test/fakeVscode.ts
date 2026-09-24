/**
 * A small in-memory stand-in for the `vscode` module, aliased in for unit
 * tests (vite.config.ts). It covers only what the extension calls and lets a
 * test drive panels, folders and prompts.
 */
type Listener<T> = (value: T) => void;

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const listener of this.listeners) listener(value);
  }
}

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;

  constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }

  static file(fsPath: string) {
    return new Uri("file", fsPath);
  }

  static joinPath(base: Uri, ...segments: string[]) {
    return new Uri(base.scheme, [base.fsPath, ...segments].join("/"));
  }

  static parse(value: string) {
    return new Uri(new URL(value).protocol.replace(/:$/, ""), value);
  }

  toString() {
    return this.scheme === "file" ? `file://${this.fsPath}` : this.fsPath;
  }
}

export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class TabInputWebview {
  readonly viewType: string;
  constructor(viewType: string) {
    this.viewType = viewType;
  }
}

export class TabInputText {
  readonly uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }
}

/** An editor tab; `panel` is set once its webview exists (VS Code restores lazily). */
export interface FakeTab {
  readonly label: string;
  readonly input: unknown;
  readonly panel?: FakePanel;
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ViewColumn = { Active: -1 } as const;
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;

const panelOf = new WeakMap<object, FakePanel>();

export class FakePanel {
  title = "";
  iconPath: unknown;
  active = true;
  disposed = false;
  /** Every message the extension posted to the webview. */
  readonly posted: unknown[] = [];
  /** How many times the extension set the webview's page. */
  renders = 0;
  private readonly disposeEmitter = new Emitter<void>();
  private readonly messageEmitter = new Emitter<unknown>();
  readonly onDidDispose = this.disposeEmitter.event;
  private page = "";
  readonly webview = {
    options: {},
    get html() {
      return panelOf.get(this)?.page ?? "";
    },
    set html(value: string) {
      const panel = panelOf.get(this);
      if (!panel) return;
      panel.page = value;
      panel.renders += 1;
    },
    onDidReceiveMessage: this.messageEmitter.event,
    postMessage: async (message: unknown) => {
      this.posted.push(message);
      return true;
    },
  };

  constructor() {
    panelOf.set(this.webview, this);
  }

  /** A message from the webview's relay script. */
  receive(message: unknown) {
    this.messageEmitter.fire(message);
  }

  reveal() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    fake.tabs = fake.tabs.filter((tab) => tab.panel !== this);
    this.disposeEmitter.fire();
  }
}

export interface FakeFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

interface PanelSerializer {
  deserializeWebviewPanel(panel: FakePanel, state: unknown): Promise<void>;
}

const folderEvents = new Emitter<{ added: FakeFolder[]; removed: FakeFolder[] }>();
const commandRegistry = new Map<string, (...args: unknown[]) => unknown>();

export const fake = {
  folders: [] as FakeFolder[],
  config: new Map<string, unknown>(),
  panels: [] as FakePanel[],
  tabs: [] as FakeTab[],
  serializer: null as PanelSerializer | null,
  /** The button the user picks in the consent modal. */
  consentAnswer: undefined as string | undefined,
  modalPrompts: 0,
  /** Picks an item in a quick pick; the default dismisses it. */
  pick: undefined as ((items: ReadonlyArray<unknown>) => unknown) | undefined,
  /** The text typed into an input box; undefined dismisses it. */
  inputAnswer: undefined as string | undefined,
  /** The button the user picks in a warning; undefined dismisses it. */
  warningAnswer: undefined as string | undefined,
  warnings: [] as string[],
  errors: [] as string[],
  opened: [] as string[],
  reset() {
    this.folders = [];
    this.config.clear();
    this.panels = [];
    this.tabs = [];
    this.serializer = null;
    this.consentAnswer = undefined;
    this.modalPrompts = 0;
    this.pick = undefined;
    this.inputAnswer = undefined;
    this.warningAnswer = undefined;
    this.warnings = [];
    this.errors = [];
    this.opened = [];
    commandRegistry.clear();
  },
  addFolder(fsPath: string, name: string) {
    const folder = { uri: Uri.file(fsPath), name, index: this.folders.length };
    this.folders = [...this.folders, folder];
    return folder;
  },
  removeFolder(folder: FakeFolder) {
    this.folders = this.folders.filter((item) => item !== folder);
    folderEvents.fire({ added: [], removed: [folder] });
  },
  execute(command: string, ...args: unknown[]) {
    const handler = commandRegistry.get(command);
    if (!handler) throw new Error(`Command ${command} is not registered.`);
    return Promise.resolve(handler(...args));
  },
};

const disposable = { dispose() {} };

export const window = {
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    name: "",
    command: "",
    backgroundColor: undefined as ThemeColor | undefined,
    show() {},
    hide() {},
    dispose() {},
  }),
  createWebviewPanel: (viewType: string, title: string) => {
    const panel = new FakePanel();
    panel.title = title;
    fake.panels.push(panel);
    fake.tabs.push({
      label: title,
      input: new TabInputWebview(`mainThreadWebview-${viewType}`),
      panel,
    });
    return panel;
  },
  tabGroups: {
    get all() {
      return [{ tabs: fake.tabs }];
    },
    close: async (tabs: ReadonlyArray<FakeTab>) => {
      fake.tabs = fake.tabs.filter((tab) => !tabs.includes(tab));
      for (const tab of tabs) tab.panel?.dispose();
      return true;
    },
  },
  registerWebviewPanelSerializer: (_viewType: string, serializer: PanelSerializer) => {
    fake.serializer = serializer;
    return disposable;
  },
  registerTreeDataProvider: () => disposable,
  showInformationMessage: async (_message: string, ...rest: unknown[]) => {
    const [options] = rest;
    if (typeof options === "object" && options !== null && "modal" in options && options.modal) {
      fake.modalPrompts += 1;
      return fake.consentAnswer;
    }
    return undefined;
  },
  showWarningMessage: async (message: string) => {
    fake.warnings.push(message);
    return fake.warningAnswer;
  },
  showErrorMessage: async (message: string) => {
    fake.errors.push(message);
    return undefined;
  },
  showQuickPick: async (items: ReadonlyArray<unknown>) => fake.pick?.(items),
  showInputBox: async () => fake.inputAnswer,
};

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    commandRegistry.set(id, handler);
    return disposable;
  },
};

export const workspace = {
  get workspaceFolders() {
    return fake.folders;
  },
  getWorkspaceFolder: (uri: Uri) =>
    fake.folders.find((folder) => folder.uri.toString() === uri.toString()),
  getConfiguration: (section: string) => ({
    get: (key: string) => fake.config.get(`${section}.${key}`),
  }),
  onDidChangeWorkspaceFolders: folderEvents.event,
};

export const env = {
  remoteName: undefined as string | undefined,
  openExternal: async (uri: Uri) => {
    fake.opened.push(uri.toString());
    return true;
  },
};
