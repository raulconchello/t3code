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
  readonly isComposing?: boolean;
  readonly altGraph?: boolean;
}

const modifierState = (init: KeyInit) => (modifier: string) =>
  modifier === "AltGraph" && init.altGraph === true;

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
    isComposing: { value: init.isComposing ?? false },
    getModifierState: { value: modifierState(init) },
  });
  return event;
}

const keys = (init: KeyInit) => ({
  code: "",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  isComposing: false,
  ...init,
  getModifierState: modifierState(init),
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
    expect(
      isHostShortcut(keys({ key: "P", code: "KeyP", metaKey: true, isComposing: true }), "darwin"),
    ).toBe(false);
    // Shift turns the others into different shortcuts, such as Cmd+Shift+X.
    expect(
      isHostShortcut(keys({ key: "x", code: "KeyX", metaKey: true, shiftKey: true }), "darwin"),
    ).toBe(true);
  });
});

describe("isHostShortcut and text input", () => {
  it("keeps AltGr characters, which Windows and Linux report as Ctrl+Alt", async () => {
    const { isHostShortcut } = await loadEmbedHost();
    const at = keys({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true });
    expect(isHostShortcut(at, "win32")).toBe(false);
    expect(isHostShortcut(at, "linux")).toBe(false);
    expect(isHostShortcut({ ...at, getModifierState: () => true }, "darwin")).toBe(false);
    // On macOS Ctrl+Alt is never AltGr, so it stays a shortcut.
    expect(isHostShortcut(at, "darwin")).toBe(true);
    // Ctrl+Alt with a non-printable key is still a shortcut elsewhere.
    expect(
      isHostShortcut(keys({ key: "F5", code: "F5", ctrlKey: true, altKey: true }), "win32"),
    ).toBe(true);
  });

  it("keeps caret movement and deletion with any modifier", async () => {
    const { isHostShortcut } = await loadEmbedHost();
    for (const key of [
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
    ]) {
      expect(isHostShortcut(keys({ key, code: key, metaKey: true }), "darwin"), key).toBe(false);
      expect(
        isHostShortcut(keys({ key, code: key, ctrlKey: true, shiftKey: true }), "win32"),
        key,
      ).toBe(false);
    }
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

describe("reserved host shortcuts", () => {
  it("are the Command Palette, Quick Open and F1, with the platform's modifier", async () => {
    const { isReservedHostShortcut } = await loadEmbedHost();
    const palette = keys({ key: "P", code: "KeyP", metaKey: true, shiftKey: true });
    const quickOpen = keys({ key: "p", code: "KeyP", metaKey: true });
    expect(isReservedHostShortcut(palette, "darwin")).toBe(true);
    expect(isReservedHostShortcut(quickOpen, "darwin")).toBe(true);
    expect(isReservedHostShortcut(keys({ key: "F1", code: "F1" }), "darwin")).toBe(true);
    expect(
      isReservedHostShortcut(
        keys({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }),
        "win32",
      ),
    ).toBe(true);
    expect(isReservedHostShortcut(keys({ key: "p", code: "KeyP", ctrlKey: true }), "linux")).toBe(
      true,
    );
    // A Cyrillic layout still means the physical P key.
    expect(isReservedHostShortcut(keys({ key: "з", code: "KeyP", ctrlKey: true }), "linux")).toBe(
      true,
    );

    expect(isReservedHostShortcut(palette, "linux")).toBe(false);
    expect(isReservedHostShortcut(keys({ key: "p", code: "KeyP", ctrlKey: true }), "darwin")).toBe(
      false,
    );
    expect(
      isReservedHostShortcut(
        keys({ key: "π", code: "KeyP", metaKey: true, altKey: true }),
        "darwin",
      ),
    ).toBe(false);
    expect(isReservedHostShortcut(keys({ key: "F1", code: "F1", shiftKey: true }), "darwin")).toBe(
      false,
    );
    expect(isReservedHostShortcut(keys({ key: "k", code: "KeyK", metaKey: true }), "darwin")).toBe(
      false,
    );
    expect(isReservedHostShortcut({ ...palette, isComposing: true }, "darwin")).toBe(false);
  });

  it("go to the host before any of the app's handlers see them", async () => {
    const frame = new FakeFrame();
    await connect(frame);
    // The app's own shortcut listeners, such as the one that pins a thread on Cmd+Shift+P.
    const appHandlers: string[] = [];
    frame.addEventListener("keydown", () => appHandlers.push("capture"), true);
    frame.addEventListener("keydown", () => appHandlers.push("bubble"));
    frame.parent.postMessage.mockClear();

    const event = keydown({ key: "P", code: "KeyP", keyCode: 80, metaKey: true, shiftKey: true });
    frame.dispatchEvent(event);

    expect(appHandlers).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
    expect(frame.parent.postMessage).toHaveBeenCalledOnce();
    expect(frame.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "t3code/keydown",
        code: "KeyP",
        metaKey: true,
        shiftKey: true,
      }),
      HOST_ORIGIN,
    );
  });

  it("leave the app's other shortcuts to the app", async () => {
    const frame = new FakeFrame();
    await connect(frame);
    const appHandlers: string[] = [];
    frame.addEventListener("keydown", (event) => {
      appHandlers.push((event as KeyboardEvent).key);
      event.preventDefault();
    });

    frame.dispatchEvent(keydown({ key: "k", code: "KeyK", metaKey: true }));

    expect(appHandlers).toEqual(["k"]);
  });
});
