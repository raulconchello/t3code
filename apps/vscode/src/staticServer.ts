// @effect-diagnostics nodeBuiltinImport:off -- A plain node:http file server for the bundled web app.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const mimeTypeFor = (filePath: string) =>
  MIME_TYPES[NodePath.extname(filePath).toLowerCase()] ?? "application/octet-stream";

type StaticResolution =
  | { readonly _tag: "File"; readonly filePath: string }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "NotFound" };

const isFile = (filePath: string) => {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

/**
 * Maps a request path onto a file under `root`. Paths that escape the root are
 * invalid; extensionless paths that match no file fall back to index.html so
 * client-side routes load the app.
 */
export function resolveStaticPath(root: string, requestPath: string): StaticResolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return { _tag: "Invalid" };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return { _tag: "Invalid" };
  }
  const segments = decoded.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    return { _tag: "Invalid" };
  }

  const resolvedRoot = NodePath.resolve(root);
  const candidate = NodePath.resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${NodePath.sep}`)) {
    return { _tag: "Invalid" };
  }

  if (segments.length > 0 && isFile(candidate)) {
    return { _tag: "File", filePath: candidate };
  }
  const indexPath = NodePath.join(resolvedRoot, "index.html");
  if (NodePath.extname(candidate) === "" && isFile(indexPath)) {
    return { _tag: "File", filePath: indexPath };
  }
  return { _tag: "NotFound" };
}

const cacheControlFor = (root: string, filePath: string) => {
  const relative = NodePath.relative(root, filePath).split(NodePath.sep).join("/");
  if (relative === "index.html") return "no-store";
  if (relative.startsWith("assets/")) return "public, max-age=31536000, immutable";
  return "no-cache";
};

function createStaticRequestHandler(input: {
  readonly root: string;
  /** The port the server listens on, for the Host header check. */
  readonly port: () => number;
}): NodeHttp.RequestListener {
  const root = NodePath.resolve(input.root);
  const sendText = (response: NodeHttp.ServerResponse, status: number, text: string) => {
    response.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(text);
  };

  return (request, response) => {
    // Rejects DNS-rebinding and other hosts: only the exact loopback origin loads the app.
    if (request.headers.host !== `127.0.0.1:${input.port()}`) {
      sendText(response, 403, "Forbidden");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendText(response, 405, "Method Not Allowed");
      return;
    }

    const pathname = (request.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
    const resolution = resolveStaticPath(root, pathname);
    if (resolution._tag === "Invalid") {
      sendText(response, 400, "Bad Request");
      return;
    }
    if (resolution._tag === "NotFound") {
      sendText(response, 404, "Not Found");
      return;
    }

    let size: number;
    try {
      size = NodeFS.statSync(resolution.filePath).size;
    } catch {
      sendText(response, 404, "Not Found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypeFor(resolution.filePath),
      "Content-Length": size,
      "Cache-Control": cacheControlFor(root, resolution.filePath),
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = NodeFS.createReadStream(resolution.filePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };
}

export interface StaticServer {
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

const listen = (server: NodeHttp.Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

/**
 * Serves `root` on 127.0.0.1. Tries `preferredPort` first so the app keeps its
 * origin (and with it its browser storage) across sessions, and falls back to
 * a free port when that one is taken.
 */
export async function startStaticServer(input: {
  readonly root: string;
  readonly preferredPort?: number;
}): Promise<StaticServer> {
  let port = 0;
  const server = NodeHttp.createServer(
    createStaticRequestHandler({ root: input.root, port: () => port }),
  );
  try {
    await listen(server, input.preferredPort ?? 0);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
      throw error;
    }
    await listen(server, 0);
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The T3 Code web server didn't get a port.");
  }
  port = address.port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
