// @effect-diagnostics nodeBuiltinImport:off -- Serves a fake descriptor over node:http.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  discoverDesktopServer,
  isLoopbackHttpOrigin,
  parseServerRuntimeState,
  resolveT3Home,
  versionSkewWarning,
} from "./desktopServer.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const makeHome = (runtimeState?: unknown) => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-vscode-home-"));
  cleanups.push(() => NodeFS.rmSync(home, { recursive: true, force: true }));
  if (runtimeState !== undefined) {
    NodeFS.mkdirSync(NodePath.join(home, "userdata"));
    NodeFS.writeFileSync(
      NodePath.join(home, "userdata", "server-runtime.json"),
      typeof runtimeState === "string" ? runtimeState : `${JSON.stringify(runtimeState)}\n`,
    );
  }
  return home;
};

const descriptor = (overrides: Record<string, unknown> = {}) => ({
  environmentId: "env-desktop",
  label: "Studio Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.42",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
  ...overrides,
});

/** A loopback server answering the descriptor route like a T3 server. */
const serveDescriptor = async (status: number, body: unknown) => {
  const requests: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { origin: `http://127.0.0.1:${address.port}`, requests };
};

describe("resolveT3Home", () => {
  it("prefers the setting, then T3CODE_HOME, then ~/.t3", () => {
    const homeDirectory = "/Users/alice";
    assert.equal(
      resolveT3Home({ setting: " /data/t3 ", envHome: "/env/t3", homeDirectory }),
      "/data/t3",
    );
    assert.equal(resolveT3Home({ setting: "", envHome: "/env/t3", homeDirectory }), "/env/t3");
    assert.equal(
      resolveT3Home({ setting: undefined, envHome: " ", homeDirectory }),
      "/Users/alice/.t3",
    );
    assert.equal(
      resolveT3Home({ setting: "~/sandbox", envHome: undefined, homeDirectory }),
      "/Users/alice/sandbox",
    );
  });
});

describe("parseServerRuntimeState", () => {
  it("reads the fields the server writes and ignores the rest", () => {
    assert.deepEqual(
      parseServerRuntimeState(
        '{"version":1,"pid":62135,"host":"127.0.0.1","port":3773,"origin":"http://127.0.0.1:3773","startedAt":"2026-09-24T17:02:49.890Z"}\n',
      ),
      { version: 1, pid: 62135, origin: "http://127.0.0.1:3773" },
    );
  });

  it("returns null for empty, malformed or unknown files", () => {
    assert.isNull(parseServerRuntimeState("  \n"));
    assert.isNull(parseServerRuntimeState("{not json"));
    assert.isNull(parseServerRuntimeState('{"version":2,"pid":1,"origin":"http://127.0.0.1:1"}'));
    assert.isNull(parseServerRuntimeState('{"version":1,"origin":"http://127.0.0.1:1"}'));
  });
});

describe("isLoopbackHttpOrigin", () => {
  it("accepts only plain HTTP on loopback names", () => {
    assert.isTrue(isLoopbackHttpOrigin("http://127.0.0.1:3773"));
    assert.isTrue(isLoopbackHttpOrigin("http://localhost:3773"));
    assert.isTrue(isLoopbackHttpOrigin("http://[::1]:3773"));
    assert.isFalse(isLoopbackHttpOrigin("http://192.168.1.20:3773"));
    assert.isFalse(isLoopbackHttpOrigin("https://127.0.0.1:3773"));
    assert.isFalse(isLoopbackHttpOrigin("not a url"));
  });
});

describe("discoverDesktopServer", () => {
  it("reports a home without a runtime file as not running", async () => {
    const home = makeHome();
    assert.deepEqual(await discoverDesktopServer(home), { _tag: "NotRunning", home });
  });

  it("treats a runtime file whose process is gone as not running", async () => {
    const home = makeHome({ version: 1, pid: 4242, origin: "http://127.0.0.1:1" });
    assert.deepEqual(await discoverDesktopServer(home, { isAlive: () => false }), {
      _tag: "NotRunning",
      home,
    });
  });

  it("refuses a server that is not on loopback", async () => {
    const home = makeHome({ version: 1, pid: process.pid, origin: "http://10.0.0.5:3773" });
    const result = await discoverDesktopServer(home);
    assert.equal(result._tag, "Unavailable");
  });

  it("checks the descriptor and returns the endpoints to pair with", async () => {
    const { origin, requests } = await serveDescriptor(200, descriptor());
    const home = makeHome({ version: 1, pid: process.pid, port: 1, origin });
    assert.deepEqual<unknown>(await discoverDesktopServer(home), {
      _tag: "Found",
      server: {
        home,
        pid: process.pid,
        environmentId: "env-desktop",
        label: "Studio Mac",
        serverVersion: "0.0.42",
        httpBaseUrl: `${origin}/`,
        wsBaseUrl: `${origin.replace("http:", "ws:")}/`,
      },
    });
    assert.deepEqual(requests, ["/.well-known/t3/environment"]);
  });

  it("blocks an incompatible orchestration protocol", async () => {
    const { origin } = await serveDescriptor(
      200,
      descriptor({ orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }),
    );
    const home = makeHome({ version: 1, pid: process.pid, origin });
    const result = await discoverDesktopServer(home);
    assert.equal(result._tag, "Unavailable");
    assert.include(result._tag === "Unavailable" ? result.message : "", "not supported");
  });

  it("reports a server that does not answer with a descriptor", async () => {
    const { origin } = await serveDescriptor(200, { hello: "world" });
    const home = makeHome({ version: 1, pid: process.pid, origin });
    const result = await discoverDesktopServer(home);
    assert.equal(result._tag, "Unavailable");
    assert.include(result._tag === "Unavailable" ? result.message : "", origin);
  });
});

describe("versionSkewWarning", () => {
  it("warns only when the versions differ", () => {
    assert.isNull(versionSkewWarning("0.0.42", "0.0.42"));
    assert.include(versionSkewWarning("0.0.43", "0.0.42") ?? "", "0.0.43");
  });
});
