// @effect-diagnostics nodeBuiltinImport:off -- Exercises the node:http server over real sockets.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, beforeAll, describe, it } from "vite-plus/test";

import { type StaticServer, resolveStaticPath, startStaticServer } from "./staticServer.ts";

let sandbox: string;
let root: string;
let server: StaticServer;

beforeAll(async () => {
  sandbox = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-vscode-static-")),
  );
  root = NodePath.join(sandbox, "web");
  NodeFS.mkdirSync(NodePath.join(root, "assets"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "index.html"), "<!doctype html><title>app</title>");
  NodeFS.writeFileSync(NodePath.join(root, "assets", "index-abc12345.js"), "console.log(1);");
  NodeFS.writeFileSync(NodePath.join(root, "assets", "ghostty-abc12345.wasm"), "\0asm");
  NodeFS.writeFileSync(NodePath.join(root, "favicon.ico"), "icon");
  NodeFS.writeFileSync(NodePath.join(sandbox, "secret.txt"), "secret");
  NodeFS.mkdirSync(NodePath.join(sandbox, "private"));
  NodeFS.writeFileSync(NodePath.join(sandbox, "private", "notes.js"), "secret");
  // Links inside the root: one to its own file, two that lead out of it.
  NodeFS.symlinkSync(
    NodePath.join(root, "assets", "index-abc12345.js"),
    NodePath.join(root, "assets", "alias-abc12345.js"),
  );
  NodeFS.symlinkSync(NodePath.join(sandbox, "secret.txt"), NodePath.join(root, "leak.txt"));
  NodeFS.symlinkSync(NodePath.join(sandbox, "private"), NodePath.join(root, "linked"));
  server = await startStaticServer({ root });
});

afterAll(async () => {
  await server.close();
  NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

interface RawResponse {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

/** Sends the path verbatim, so traversal attempts reach the server unnormalized. */
const request = (
  path: string,
  options: { readonly method?: string; readonly host?: string } = {},
): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method: options.method ?? "GET",
        path,
        headers: { host: options.host ?? `127.0.0.1:${server.port}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

describe("static server", () => {
  it("serves index.html at the root without caching", async () => {
    const response = await request("/");
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.include(response.body, "<title>app</title>");
  });

  it("falls back to index.html for client-side routes", async () => {
    const response = await request("/threads/thread-1?tab=diff");
    assert.equal(response.status, 200);
    assert.include(response.body, "<title>app</title>");
  });

  it("does not fall back for missing files", async () => {
    assert.equal((await request("/assets/missing-abc12345.js")).status, 404);
  });

  it("serves hashed assets as immutable with their MIME type", async () => {
    const script = await request("/assets/index-abc12345.js");
    assert.equal(script.status, 200);
    assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(script.headers["cache-control"], "public, max-age=31536000, immutable");

    const wasm = await request("/assets/ghostty-abc12345.wasm");
    assert.equal(wasm.headers["content-type"], "application/wasm");
  });

  it("revalidates files outside /assets", async () => {
    assert.equal((await request("/favicon.ico")).headers["cache-control"], "no-cache");
  });

  it("sends no CORS headers", async () => {
    const response = await request("/");
    assert.isUndefined(response.headers["access-control-allow-origin"]);
  });

  it("rejects paths that escape the web root", async () => {
    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/..%5csecret.txt",
      "/index.html%00.js",
      "/%E0%A4%A",
    ]) {
      const response = await request(path);
      assert.equal(response.status, 400, path);
      assert.notInclude(response.body, "secret", path);
    }
  });

  it("refuses symlinks that lead out of the web root", async () => {
    for (const path of ["/leak.txt", "/linked/notes.js", "/linked"]) {
      const response = await request(path);
      assert.equal(response.status, 400, path);
      assert.notInclude(response.body, "secret", path);
    }
    const alias = await request("/assets/alias-abc12345.js");
    assert.equal(alias.status, 200);
    assert.equal(alias.body, "console.log(1);");
  });

  it("only answers requests addressed to its exact loopback origin", async () => {
    assert.equal((await request("/", { host: `localhost:${server.port}` })).status, 403);
    assert.equal((await request("/", { host: "attacker.example" })).status, 403);
    assert.equal((await request("/", { host: `127.0.0.1:${server.port + 1}` })).status, 403);
  });

  it("allows only GET and HEAD", async () => {
    const post = await request("/", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
    assert.equal((await request("/", { method: "OPTIONS" })).status, 405);

    const head = await request("/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(
      head.headers["content-length"],
      String("<!doctype html><title>app</title>".length),
    );
  });

  it("keeps a preferred port and moves when it is taken", async () => {
    const again = await startStaticServer({ root, preferredPort: server.port });
    try {
      assert.notEqual(again.port, server.port);
    } finally {
      await again.close();
    }
    const freed = again.port;
    const reused = await startStaticServer({ root, preferredPort: freed });
    try {
      assert.equal(reused.port, freed);
      assert.equal(reused.origin, `http://127.0.0.1:${freed}`);
    } finally {
      await reused.close();
    }
  });
});

describe("resolveStaticPath", () => {
  it("refuses an index.html that links out of the root, and serves through a linked root", () => {
    const linkedRoot = NodePath.join(sandbox, "linked-web");
    NodeFS.symlinkSync(root, linkedRoot);
    assert.deepEqual(resolveStaticPath(linkedRoot, "/threads/1"), {
      _tag: "File",
      filePath: NodePath.join(root, "index.html"),
    });

    const hostile = NodePath.join(sandbox, "hostile-web");
    NodeFS.mkdirSync(hostile);
    NodeFS.symlinkSync(NodePath.join(sandbox, "secret.txt"), NodePath.join(hostile, "index.html"));
    assert.deepEqual(resolveStaticPath(hostile, "/threads/1"), { _tag: "Invalid" });
  });

  it("keeps every resolved file inside the root", () => {
    assert.deepEqual(resolveStaticPath(root, "/assets/index-abc12345.js"), {
      _tag: "File",
      filePath: NodePath.join(root, "assets", "index-abc12345.js"),
    });
    assert.deepEqual(resolveStaticPath(root, "/%2e%2e/%2e%2e/etc/passwd"), { _tag: "Invalid" });
    assert.deepEqual(resolveStaticPath(root, "/assets"), {
      _tag: "File",
      filePath: NodePath.join(root, "index.html"),
    });
  });
});
