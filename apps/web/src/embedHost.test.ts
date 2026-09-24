import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type EmbedHostInitMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vite-plus/test";

const HOST_ORIGIN = "vscode-webview://panel";

function initMessage(bearerToken = "token"): EmbedHostInitMessage {
  return {
    version: 1,
    type: "t3code/init",
    workspace: { workspaceRoot: "/work/app", aliases: [], platform: "darwin", label: "app" },
    environment: {
      environmentId: EnvironmentId.make("environment"),
      label: "My Mac",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bearerToken,
    },
  };
}

class FakeFrame extends EventTarget {
  readonly parent = { postMessage: vi.fn() };
  readonly location = { origin: "http://127.0.0.1:38780", reload: vi.fn() };

  receive(data: unknown, options: { source?: unknown; origin?: string } = {}) {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: { value: data },
      origin: { value: options.origin ?? HOST_ORIGIN },
      source: { value: "source" in options ? options.source : this.parent },
    });
    this.dispatchEvent(event);
  }
}

async function loadEmbedHost() {
  vi.resetModules();
  return import("./embedHost");
}

async function connect(frame: FakeFrame) {
  const embedHost = await loadEmbedHost();
  const connected = embedHost.connectEmbedHost(frame as unknown as Window);
  frame.receive(initMessage());
  await connected;
  return embedHost;
}

describe("connectEmbedHost", () => {
  let frame: FakeFrame;

  beforeEach(() => {
    frame = new FakeFrame();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says hello to the parent and resolves with its init", async () => {
    const embedHost = await loadEmbedHost();
    const connected = embedHost.connectEmbedHost(frame as unknown as Window);

    expect(frame.parent.postMessage).toHaveBeenCalledWith(
      { version: 1, type: "t3code/hello" },
      "*",
    );
    expect(embedHost.readEmbedHost()).toBeNull();

    frame.receive(initMessage());

    await expect(connected).resolves.toEqual(initMessage());
    expect(embedHost.readEmbedHost()).toEqual(initMessage());
  });

  it("ignores messages that are not an init from the parent window", async () => {
    const embedHost = await loadEmbedHost();
    void embedHost.connectEmbedHost(frame as unknown as Window);

    frame.receive(initMessage(), { source: null });
    frame.receive({ ...initMessage(), version: 2 });
    frame.receive({ type: "t3code/init" });

    expect(embedHost.readEmbedHost()).toBeNull();
  });

  it("replies to the origin the init came from", async () => {
    const embedHost = await connect(frame);
    frame.parent.postMessage.mockClear();

    embedHost.reportEmbedHostStatus({ phase: "connecting" });

    expect(frame.parent.postMessage).toHaveBeenCalledWith(
      { version: 1, type: "t3code/status", phase: "connecting" },
      HOST_ORIGIN,
    );
  });

  it("reloads for a different init and ignores a repeated one", async () => {
    await connect(frame);

    frame.receive(initMessage());
    frame.receive(initMessage("new-token"), { origin: "https://elsewhere.example" });
    expect(frame.location.reload).not.toHaveBeenCalled();

    frame.receive(initMessage("new-token"));
    expect(frame.location.reload).toHaveBeenCalledOnce();
  });

  it("fails to start when the host's origin is opaque", async () => {
    const embedHost = await loadEmbedHost();
    const connected = embedHost.connectEmbedHost(frame as unknown as Window);

    frame.receive(initMessage(), { origin: "null" });

    await expect(connected).rejects.toThrow("opaque origin");
    expect(embedHost.readEmbedHost()).toBeNull();
  });

  it("logs a reply the browser refuses to send instead of throwing", async () => {
    const embedHost = await connect(frame);
    frame.parent.postMessage.mockImplementation(() => {
      throw new DOMException("Invalid target origin", "SyntaxError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => embedHost.reportEmbedHostStatus({ phase: "ready" })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("refuses to start outside a frame", async () => {
    const embedHost = await loadEmbedHost();
    const topWindow = { parent: null as unknown };
    topWindow.parent = topWindow;

    await expect(embedHost.connectEmbedHost(topWindow as unknown as Window)).rejects.toThrow(
      "only runs inside its host app",
    );
  });

  it.effect("serves the connection catalog from the init instead of browser storage", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => connect(frame));
      const getConnectionCatalog = vi.fn();
      vi.stubGlobal("window", {
        desktopBridge: { getConnectionCatalog, setConnectionCatalog: vi.fn() },
      });
      const { makeCatalogBackend } = yield* Effect.promise(() => import("./connection/storage"));

      const raw = yield* makeCatalogBackend({} as IDBDatabase).read;

      expect(raw).toContain("bearer:environment");
      expect(getConnectionCatalog).not.toHaveBeenCalled();
    }),
  );
});

interface KeyInit {
  readonly key: string;
  readonly code?: string;
  readonly keyCode?: number;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

function keydown(init: KeyInit) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    key: { value: init.key },
    code: { value: init.code ?? "" },
    keyCode: { value: init.keyCode ?? 0 },
    altKey: { value: init.altKey ?? false },
    ctrlKey: { value: init.ctrlKey ?? false },
    metaKey: { value: init.metaKey ?? false },
    shiftKey: { value: init.shiftKey ?? false },
    repeat: { value: false },
    isComposing: { value: false },
  });
  return event;
}

const keys = (init: KeyInit) => ({
  code: "",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...init,
});

describe("isHostShortcut", () => {
  it("passes Cmd shortcuts on macOS and Ctrl shortcuts everywhere", async () => {
    const { isHostShortcut } = await loadEmbedHost();
    const palette = keys({ key: "P", code: "KeyP", metaKey: true, shiftKey: true });
    expect(isHostShortcut(palette, "darwin")).toBe(true);
    expect(isHostShortcut(palette, "linux")).toBe(false);
    expect(
      isHostShortcut(keys({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }), "win32"),
    ).toBe(true);
    expect(isHostShortcut(keys({ key: "w", code: "KeyW", metaKey: true }), "darwin")).toBe(true);
    expect(isHostShortcut(keys({ key: "1", code: "Digit1", metaKey: true }), "darwin")).toBe(true);
    expect(isHostShortcut(keys({ key: "F1", code: "F1" }), "linux")).toBe(true);
  });

  it("keeps typing and native editing shortcuts in the app", async () => {
    const { isHostShortcut } = await loadEmbedHost();
    expect(isHostShortcut(keys({ key: "p", code: "KeyP" }), "darwin")).toBe(false);
    expect(isHostShortcut(keys({ key: "P", code: "KeyP", shiftKey: true }), "darwin")).toBe(false);
    expect(isHostShortcut(keys({ key: "Enter", code: "Enter" }), "darwin")).toBe(false);
    expect(isHostShortcut(keys({ key: "Meta", code: "MetaLeft", metaKey: true }), "darwin")).toBe(
      false,
    );
    for (const letter of ["a", "c", "v", "x", "y", "z"]) {
      const code = `Key${letter.toUpperCase()}`;
      expect(isHostShortcut(keys({ key: letter, code, metaKey: true }), "darwin")).toBe(false);
      expect(isHostShortcut(keys({ key: letter, code, ctrlKey: true }), "win32")).toBe(false);
    }
    expect(
      isHostShortcut(keys({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }), "darwin"),
    ).toBe(false);
    // A Cyrillic layout still copies with the physical C key.
    expect(isHostShortcut(keys({ key: "с", code: "KeyC", ctrlKey: true }), "linux")).toBe(false);
    // Shift turns the others into different shortcuts, such as Cmd+Shift+X.
    expect(
      isHostShortcut(keys({ key: "x", code: "KeyX", metaKey: true, shiftKey: true }), "darwin"),
    ).toBe(true);
  });
});

describe("host shortcut forwarding", () => {
  const afterDispatch = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("sends shortcuts the app didn't handle to the host", async () => {
    const frame = new FakeFrame();
    await connect(frame);
    frame.parent.postMessage.mockClear();

    frame.dispatchEvent(
      keydown({ key: "P", code: "KeyP", keyCode: 80, metaKey: true, shiftKey: true }),
    );
    await afterDispatch();

    expect(frame.parent.postMessage).toHaveBeenCalledWith(
      {
        version: 1,
        type: "t3code/keydown",
        key: "P",
        code: "KeyP",
        keyCode: 80,
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        repeat: false,
      },
      HOST_ORIGIN,
    );
  });

  it("keeps shortcuts the app handled, even in a listener added later", async () => {
    const frame = new FakeFrame();
    await connect(frame);
    frame.addEventListener("keydown", (event) => event.preventDefault());
    frame.parent.postMessage.mockClear();

    frame.dispatchEvent(keydown({ key: "k", code: "KeyK", metaKey: true }));
    frame.dispatchEvent(keydown({ key: "p", code: "KeyP" }));
    await afterDispatch();

    expect(frame.parent.postMessage).not.toHaveBeenCalled();
  });
});
