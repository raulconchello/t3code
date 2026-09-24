// @effect-diagnostics nodeBuiltinImport:off -- Runs the webview's inline relay script in a Node VM.
import * as NodeVM from "node:vm";

import { assert, beforeEach, describe, it } from "vite-plus/test";

import { renderAppHtml } from "./panel.ts";

const APP_ORIGIN = "http://127.0.0.1:41000";
const WEBVIEW_ORIGIN = "vscode-webview://panel";

class FakeKeyboardEvent extends Event {
  readonly init: Record<string, unknown>;
  constructor(type: string, init: Record<string, unknown>) {
    super(type, init);
    this.init = init;
  }
}

/** The webview page around the relay: its window, the app iframe and VS Code's API. */
const loadRelay = () => {
  const html = renderAppHtml({ nonce: "nonce", appOrigin: APP_ORIGIN, state: { folderUri: "x" } });
  const script = /<script nonce="nonce">([\s\S]*)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("no relay script");

  const toExtension: unknown[] = [];
  const toFrame: Array<{ message: unknown; targetOrigin: string }> = [];
  const replayed: Array<Record<string, unknown>> = [];
  const pageWindow = Object.assign(new EventTarget(), { origin: WEBVIEW_ORIGIN });
  pageWindow.addEventListener("keydown", (event) => {
    if (event instanceof FakeKeyboardEvent) replayed.push(event.init);
  });
  const frameWindow = {
    postMessage: (message: unknown, targetOrigin: string) =>
      toFrame.push({ message, targetOrigin }),
  };
  NodeVM.runInNewContext(script, {
    window: pageWindow,
    document: { getElementById: () => ({ contentWindow: frameWindow }) },
    acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => toExtension.push(message),
      setState: () => {},
    }),
    KeyboardEvent: FakeKeyboardEvent,
  });

  const receive = (data: unknown, from: { source: unknown; origin: string }) => {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: { value: data },
      source: { value: from.source },
      origin: { value: from.origin },
    });
    pageWindow.dispatchEvent(event);
  };
  return {
    fromFrame: (data: unknown, origin = APP_ORIGIN) =>
      receive(data, { source: frameWindow, origin }),
    fromExtension: (data: unknown) => receive(data, { source: null, origin: WEBVIEW_ORIGIN }),
    toExtension,
    toFrame,
    replayed,
  };
};

const keydown = (fields: Record<string, unknown>) => ({
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
  ...fields,
});

describe("webview relay", () => {
  let relay: ReturnType<typeof loadRelay>;
  beforeEach(() => {
    relay = loadRelay();
  });

  it("passes the app's messages to the extension and the extension's to the app's origin", () => {
    relay.fromFrame({ version: 1, type: "t3code/hello" });
    relay.fromExtension({ kind: "t3code-host/to-frame", message: { type: "t3code/init" } });

    assert.deepEqual(relay.toExtension, [
      { kind: "t3code-host/from-frame", message: { version: 1, type: "t3code/hello" } },
    ]);
    assert.deepEqual(relay.toFrame, [
      { message: { type: "t3code/init" }, targetOrigin: APP_ORIGIN },
    ]);
  });

  it("ignores the frame when it isn't on the app's origin", () => {
    relay.fromFrame({ version: 1, type: "t3code/hello" }, "http://127.0.0.1:9");
    relay.fromFrame(keydown({}), "http://127.0.0.1:9");
    assert.deepEqual(relay.toExtension, []);
    assert.deepEqual(relay.replayed, []);
  });

  it("replays shortcuts from the app on the page, where VS Code sees them", () => {
    relay.fromFrame(keydown({}));
    relay.fromFrame(
      keydown({ key: "F1", code: "F1", keyCode: 112, metaKey: false, shiftKey: false }),
    );

    assert.deepEqual(relay.replayed, [
      {
        key: "P",
        code: "KeyP",
        keyCode: 80,
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
        repeat: false,
        bubbles: true,
        cancelable: true,
      },
      {
        key: "F1",
        code: "F1",
        keyCode: 112,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        bubbles: true,
        cancelable: true,
      },
    ]);
    assert.deepEqual(relay.toExtension, []);
  });

  it("takes key and keyCode from the code, not from the message", () => {
    relay.fromFrame(keydown({ key: "Enter", code: "KeyW", keyCode: 13, shiftKey: false }));
    relay.fromFrame(
      keydown({
        key: "x",
        code: "Backquote",
        keyCode: 0,
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
      }),
    );

    assert.deepEqual(
      relay.replayed.map(({ key, code, keyCode }) => ({ key, code, keyCode })),
      [
        { key: "w", code: "KeyW", keyCode: 87 },
        { key: "`", code: "Backquote", keyCode: 192 },
      ],
    );
  });

  it("never replays plain typing or keys outside the shortcut set", () => {
    relay.fromFrame(
      keydown({ key: "a", code: "KeyA", keyCode: 65, metaKey: false, shiftKey: false }),
    );
    relay.fromFrame(keydown({ code: "KeyA", metaKey: "true" }));
    for (const code of [
      "Enter",
      "Space",
      "Tab",
      "ArrowUp",
      "Backspace",
      "Numpad1",
      "__proto__",
      42,
    ]) {
      relay.fromFrame(keydown({ code, ctrlKey: true, metaKey: true }));
    }
    assert.deepEqual(relay.replayed, []);
  });
});
