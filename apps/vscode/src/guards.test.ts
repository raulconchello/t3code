import { assert, describe, it } from "vite-plus/test";

import { externalUrlToOpen, recordAuthFailure } from "./guards.ts";

describe("externalUrlToOpen", () => {
  it("allows only http and https", () => {
    assert.equal(
      externalUrlToOpen("https://github.com/pingdotgg/t3code"),
      "https://github.com/pingdotgg/t3code",
    );
    assert.equal(externalUrlToOpen("http://localhost:5173/"), "http://localhost:5173/");
    for (const url of [
      "file:///etc/passwd",
      "vscode://settings",
      "command:workbench.action.terminal.new",
      "javascript:alert(1)",
      "not a url",
    ]) {
      assert.isNull(externalUrlToOpen(url), url);
    }
  });
});

describe("recordAuthFailure", () => {
  it("allows two re-pairs a minute, then stops", () => {
    const first = recordAuthFailure([], 0);
    const second = recordAuthFailure(first.recent, 10_000);
    const third = recordAuthFailure(second.recent, 20_000);
    assert.isFalse(first.exhausted);
    assert.isFalse(second.exhausted);
    assert.isTrue(third.exhausted);
  });

  it("forgets failures older than a minute", () => {
    const later = recordAuthFailure([0, 10_000], 75_000);
    assert.isFalse(later.exhausted);
    assert.deepEqual(later.recent, [75_000]);
  });
});
