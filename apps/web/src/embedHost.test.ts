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
