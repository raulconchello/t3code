// @effect-diagnostics nodeBuiltinImport:off -- Sets up a fake extension folder on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it, vi } from "vite-plus/test";
import type * as vscodeTypes from "vscode";

import { type FakeFolder, type FakePanel, Uri, fake, window } from "../test/fakeVscode.ts";
import type { DesktopServer, DesktopServerDiscovery } from "./desktopServer.ts";
import type { StaticServer } from "./staticServer.ts";

/** The extension's I/O edges, swapped per test. Everything between them is real. */
const io = vi.hoisted(() => ({
  discover: (_home: string): Promise<DesktopServerDiscovery> =>
    Promise.reject(new Error("discover is not set up")),
  mint: (): Promise<string> => Promise.reject(new Error("mint is not set up")),
  exchange: (credential: string): Promise<string> => Promise.resolve(`bearer-for-${credential}`),
  validate: (_token: string): Promise<"valid" | "invalid"> => Promise.resolve("valid"),
  startStaticServer: (_input: {
    readonly root: string;
    readonly preferredPort?: number;
  }): Promise<StaticServer> => Promise.reject(new Error("static server is not set up")),
}));

vi.mock("./desktopServer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktopServer.ts")>()),
  discoverDesktopServer: (home: string) => io.discover(home),
}));
vi.mock("./credentials.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.ts")>()),
  exchangePairingCredential: (input: { readonly credential: string }) =>
    io.exchange(input.credential),
  validateBearerToken: (input: { readonly bearerToken: string }) => io.validate(input.bearerToken),
}));
vi.mock("./pairingCli.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pairingCli.ts")>()),
  findServerCli: async () => ({ command: "t3", args: [] }),
  mintPairingToken: () => io.mint(),
}));
vi.mock("./staticServer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./staticServer.ts")>()),
  startStaticServer: (input: { readonly root: string; readonly preferredPort?: number }) =>
    io.startStaticServer(input),
}));

const { activate } = await import("./extension.ts");

/** Everything here resolves through promises alone, so one macrotask turn drains it. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

const server = (environmentId = "env-desktop", port = 3773): DesktopServer => ({
  home: "/sandbox/t3-home",
  pid: 1234,
  environmentId: environmentId as EnvironmentId,
  label: "Studio Mac",
  serverVersion: "0.0.42",
  httpBaseUrl: `http://127.0.0.1:${port}/`,
  wsBaseUrl: `ws://127.0.0.1:${port}/`,
});

interface FakeStaticServer extends StaticServer {
  closed: boolean;
}

/** Fake static servers that model ports: a busy preferred port gets a new one. */
const makeStaticServers = () => {
  const started: FakeStaticServer[] = [];
  let nextPort = 41_000;
  const listening = () => started.filter((item) => !item.closed);
  io.startStaticServer = async ({ preferredPort }) => {
    const busy = listening().some((item) => item.port === preferredPort);
    const port = preferredPort !== undefined && !busy ? preferredPort : nextPort++;
    const created: FakeStaticServer = {
      port,
      origin: `http://127.0.0.1:${port}`,
      closed: false,
      close: async () => {
        created.closed = true;
      },
    };
    started.push(created);
    return created;
  };
  return { started, listening };
};

let extensionDir: string;
let globalState: Map<string, unknown>;
let secrets: Map<string, string>;
let context: vscodeTypes.ExtensionContext;
let subscriptions: Array<{ dispose(): unknown }>;
let mints: number;

beforeEach(() => {
  fake.reset();
  fake.config.set("t3code.homeDir", "/sandbox/t3-home");
  extensionDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-vscode-ext-"));
  NodeFS.mkdirSync(NodePath.join(extensionDir, "dist", "web"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(extensionDir, "dist", "web", "index.html"), "app");
  globalState = new Map();
  secrets = new Map();
  subscriptions = [];
  mints = 0;
  io.discover = async () => ({ _tag: "Found", server: server() });
  io.mint = async () => `pairing-${++mints}`;
  io.exchange = async (credential) => `bearer-for-${credential}`;
  io.validate = async () => "valid";
  const fakeContext = {
    extensionUri: Uri.file(extensionDir),
    extensionMode: 3,
    subscriptions,
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) globalState.delete(key);
        else globalState.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  };
  context = fakeContext as unknown as vscodeTypes.ExtensionContext;
  activate(context);
});

afterEach(() => {
  for (const subscription of subscriptions) subscription.dispose();
  NodeFS.rmSync(extensionDir, { recursive: true, force: true });
});

const grantConsent = () => globalState.set("t3code.pairingConsent", true);

/** What a panel shows: the app's origin, or the title of a message page. */
const pageOf = (panel: FakePanel) => {
  const html = panel.webview.html;
  const app = /<iframe id="app" src="([^"]+)\/"/.exec(html)?.[1];
  if (app) return { app };
  return { message: /<h2>([^<]*)<\/h2>/.exec(html)?.[1] ?? "" };
};

const fromFrame = (panel: FakePanel, message: Record<string, unknown>) =>
  panel.receive({ kind: "t3code-host/from-frame", message: { version: 1, ...message } });

/** The environment in the latest init the extension sent to the panel. */
const lastInitEnvironment = (panel: FakePanel) => {
  const init = panel.posted.at(-1);
  if (typeof init !== "object" || init === null || !("message" in init)) return null;
  const message = init.message;
  return typeof message === "object" && message !== null && "environment" in message
    ? (message.environment as { bearerToken: string; httpBaseUrl: string })
    : null;
};
const lastInitToken = (panel: FakePanel) => lastInitEnvironment(panel)?.bearerToken ?? null;

/** Opens a folder and lets its app say hello, so it holds an init. */
const openApp = async (folder: FakeFolder) => {
  await openFolder(folder);
  const panel = fake.panels.at(-1)!;
  fromFrame(panel, { type: "t3code/hello" });
  await flush();
  return panel;
};

const openFolder = (folder: FakeFolder) => fake.execute("t3code.open", folder.uri);

describe("static servers", () => {
  it("closing the tab while connecting leaves no server running", async () => {
    const statics = makeStaticServers();
    const folder = fake.addFolder("/work/app", "app");
    grantConsent();
    const discovery = gate();
    io.discover = async () => {
      await discovery.promise;
      return { _tag: "Found", server: server() };
    };

    const opening = openFolder(folder);
    await flush();
    fake.panels[0]?.dispose();
    discovery.open();
    await opening;
    await flush();

    assert.deepEqual(statics.listening(), []);
  });

  it("closing the tab while its server starts closes that server", async () => {
    const statics = makeStaticServers();
    const start = io.startStaticServer;
    const starting = gate();
    io.startStaticServer = async (input) => {
      await starting.promise;
      return start(input);
    };
    const folder = fake.addFolder("/work/app", "app");
    grantConsent();

    const opening = openFolder(folder);
    await flush();
    fake.panels[0]?.dispose();
    starting.open();
    await opening;
    await flush();

    assert.equal(statics.started.length, 1);
    assert.deepEqual(statics.listening(), []);
  });

  it("Reload while connecting shares one server and keeps the folder's port", async () => {
    const statics = makeStaticServers();
    const folder = fake.addFolder("/work/app", "app");
    const portKey = `t3code.port:${folder.uri.toString()}`;
    globalState.set(portKey, 40_123);
    grantConsent();
    const discovery = gate();
    io.discover = async () => {
      await discovery.promise;
      return { _tag: "Found", server: server() };
    };

    const opening = openFolder(folder);
    await flush();
    const reloading = fake.execute("t3code.reload");
    const retrying = openFolder(folder);
    discovery.open();
    await Promise.all([opening, reloading, retrying]);
    await flush();

    assert.equal(statics.started.length, 1);
    assert.equal(globalState.get(portKey), 40_123);
    assert.deepEqual(pageOf(fake.panels[0]!), { app: "http://127.0.0.1:40123" });
  });

  it("a folder reopened right after closing gets its port back", async () => {
    const statics = makeStaticServers();
    const folder = fake.addFolder("/work/app", "app");
    grantConsent();
    await openFolder(folder);
    const first = pageOf(fake.panels[0]!);

    fake.panels[0]?.dispose();
    await openFolder(folder);
    await flush();

    assert.deepEqual(pageOf(fake.panels[1]!), first);
    assert.equal(statics.listening().length, 1);
  });
});

describe("pairing", () => {
  it("re-pairs silently on auth-failed, then stops asking the server after repeated failures", async () => {
    makeStaticServers();
    const folder = fake.addFolder("/work/app", "app");
    grantConsent();
    io.validate = async () => "invalid";
    await openFolder(folder);
    const panel = fake.panels[0]!;

    const tokens: Array<string | null> = [];
    for (let failure = 0; failure < 2; failure += 1) {
      fromFrame(panel, { type: "t3code/hello" });
      await flush();
      tokens.push(lastInitToken(panel));
      fromFrame(panel, { type: "t3code/status", phase: "auth-failed" });
      await flush();
      assert.property(pageOf(panel), "app");
    }
    fromFrame(panel, { type: "t3code/hello" });
    await flush();
    tokens.push(lastInitToken(panel));
    fromFrame(panel, { type: "t3code/status", phase: "auth-failed" });
    await flush();

    assert.deepEqual(tokens, [
      "bearer-for-pairing-1",
      "bearer-for-pairing-2",
      "bearer-for-pairing-3",
    ]);
    assert.equal(mints, 3);
    assert.deepEqual(pageOf(panel), { message: "T3 Code keeps rejecting VS Code&#39;s session." });
    assert.equal(fake.modalPrompts, 0);
  });

  it("an interactive open doesn't reuse a silent attempt that can't ask for consent", async () => {
    makeStaticServers();
    const restoredFolder = fake.addFolder("/work/restored", "restored");
    const openedFolder = fake.addFolder("/work/opened", "opened");
    fake.consentAnswer = "Allow";
    const discovery = gate();
    io.discover = async () => {
      await discovery.promise;
      return { _tag: "Found", server: server() };
    };

    const restoredPanel = window.createWebviewPanel("t3code.workspace", "");
    const restoring = fake.serializer!.deserializeWebviewPanel(restoredPanel, {
      folderUri: restoredFolder.uri.toString(),
    });
    await flush();
    const opening = openFolder(openedFolder);
    discovery.open();
    await Promise.all([restoring, opening]);

    assert.equal(fake.modalPrompts, 1);
    assert.property(pageOf(fake.panels.at(-1)!), "app");
    assert.deepEqual(pageOf(restoredPanel), { message: "Connect VS Code to T3 Code." });
  });

  it("Disconnect forgets every saved token, even with the desktop app closed", async () => {
    makeStaticServers();
    const folder = fake.addFolder("/work/app", "app");
    grantConsent();
    await openFolder(folder);
    io.discover = async () => ({ _tag: "Found", server: server("env-other") });
    await fake.execute("t3code.reload");
    assert.equal(secrets.size, 2);

    io.discover = async () => ({ _tag: "NotRunning", home: "/sandbox/t3-home" });
    await fake.execute("t3code.disconnect");

    assert.equal(secrets.size, 0);
    assert.isFalse(globalState.has("t3code.pairingConsent"));
    assert.isTrue(fake.panels.every((panel) => panel.disposed));
  });
  it("Disconnect while pairing leaves no token behind", async () => {
    makeStaticServers();
    const folder = fake.addFolder("/work/app", "app");
    grantConsent();
    const minting = gate();
    io.mint = async () => {
      await minting.promise;
      return `pairing-${++mints}`;
    };

    const opening = openFolder(folder);
    await flush();
    await fake.execute("t3code.disconnect");
    minting.open();
    await opening;
    await flush();

    assert.equal(secrets.size, 0);
    grantConsent();
    io.mint = async () => `pairing-${++mints}`;
    await openFolder(folder);
    assert.equal(mints, 2, "the next open pairs again instead of reusing the old attempt");
  });
});

describe("manual pairing", () => {
  it("Disconnect during a pasted token's exchange keeps it from saving or connecting", async () => {
    makeStaticServers();
    const folder = fake.addFolder("/work/app", "app");
    const exchanging = gate();
    io.exchange = async (credential) => {
      await exchanging.promise;
      return `bearer-for-${credential}`;
    };
    fake.pick = (items) => items.find((item) => (item as { id: string }).id === "paste");
    fake.inputAnswer = "http://127.0.0.1:3773/pair#token=PASTED";

    const connecting = fake.execute("t3code.connect");
    await flush();
    await fake.execute("t3code.disconnect");
    exchanging.open();
    await connecting;
    await flush();

    assert.equal(secrets.size, 0);
    assert.deepEqual(fake.errors, []);
    await openFolder(folder);
    assert.equal(fake.modalPrompts, 1, "the next open asks for consent again");
    assert.deepEqual(pageOf(fake.panels.at(-1)!), { message: "Connect VS Code to T3 Code." });
  });
});

describe("a desktop server that moved", () => {
  const moveServer = (port: number) => {
    io.discover = async () => ({ _tag: "Found", server: server("env-desktop", port) });
  };

  it("Connect hands every open app the new endpoint", async () => {
    makeStaticServers();
    grantConsent();
    const panel = await openApp(fake.addFolder("/work/app", "app"));
    assert.equal(lastInitEnvironment(panel)?.httpBaseUrl, "http://127.0.0.1:3773/");

    moveServer(3999);
    fake.pick = (items) => items.find((item) => (item as { id: string }).id === "auto");
    await fake.execute("t3code.connect");
    await flush();

    assert.equal(lastInitEnvironment(panel)?.httpBaseUrl, "http://127.0.0.1:3999/");
  });

  it("opening a panel rediscovers the server instead of reusing a stale endpoint", async () => {
    makeStaticServers();
    grantConsent();
    const first = await openApp(fake.addFolder("/work/first", "first"));

    moveServer(3999);
    const second = await openApp(fake.addFolder("/work/second", "second"));
    await flush();

    assert.equal(lastInitEnvironment(second)?.httpBaseUrl, "http://127.0.0.1:3999/");
    assert.equal(lastInitEnvironment(first)?.httpBaseUrl, "http://127.0.0.1:3999/");
  });

  it("an app that loses its connection follows the server to its new port", async () => {
    makeStaticServers();
    grantConsent();
    const panel = await openApp(fake.addFolder("/work/app", "app"));
    fromFrame(panel, { type: "t3code/status", phase: "ready" });
    await flush();

    moveServer(3999);
    fromFrame(panel, { type: "t3code/status", phase: "connecting" });
    await flush();

    assert.equal(lastInitEnvironment(panel)?.httpBaseUrl, "http://127.0.0.1:3999/");
    assert.deepEqual(fake.warnings, []);
  });

  it("an app stuck connecting to a server that didn't move offers Reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      makeStaticServers();
      grantConsent();
      const panel = await openApp(fake.addFolder("/work/app", "app"));
      fromFrame(panel, { type: "t3code/status", phase: "connecting" });
      await flush();
      const renders = panel.renders;
      fake.warningAnswer = "Reconnect";

      await vi.advanceTimersByTimeAsync(30_000);
      await flush();

      assert.deepEqual(fake.warnings, ["T3 Code can't reach the desktop app for app."]);
      assert.isAbove(panel.renders, renders, "Reconnect reloads the panel");
      assert.property(pageOf(panel), "app");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an app that becomes ready again offers nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      makeStaticServers();
      grantConsent();
      const panel = await openApp(fake.addFolder("/work/app", "app"));
      fromFrame(panel, { type: "t3code/status", phase: "connecting" });
      fromFrame(panel, { type: "t3code/status", phase: "ready" });
      await flush();

      await vi.advanceTimersByTimeAsync(30_000);
      await flush();

      assert.deepEqual(fake.warnings, []);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("folders", () => {
  it("removing a folder closes its tab and its server only", async () => {
    const statics = makeStaticServers();
    const kept = fake.addFolder("/work/kept", "kept");
    const removed = fake.addFolder("/work/removed", "removed");
    grantConsent();
    await openFolder(kept);
    await openFolder(removed);
    const [keptPanel, removedPanel] = fake.panels;

    fake.removeFolder(removed);
    await flush();

    assert.isTrue(removedPanel?.disposed);
    assert.isFalse(keptPanel?.disposed);
    assert.deepEqual(
      statics.listening().map((item) => item.origin),
      [pageOf(keptPanel!).app],
    );
  });
});
