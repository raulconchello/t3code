// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A one-shot build step outside any Effect runtime.
/**
 * Copies the embed build of the web app (apps/web/dist-vscode, from
 * `vp run --filter @t3tools/web build:vscode`) into dist/web, which the
 * extension serves to its webview.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const appDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const source = NodePath.resolve(appDir, "..", "web", "dist-vscode");
const target = NodePath.join(appDir, "dist", "web");

if (!NodeFS.existsSync(NodePath.join(source, "index.html"))) {
  console.error(
    `Missing ${NodePath.join(source, "index.html")}. Build it with \`vp run --filter @t3tools/web build:vscode\`.`,
  );
  process.exit(1);
}

NodeFS.rmSync(target, { recursive: true, force: true });
NodeFS.cpSync(source, target, {
  recursive: true,
  // The Vite manifest and sourcemaps are build metadata, not app files.
  filter: (entry) => NodePath.basename(entry) !== ".vite" && !entry.endsWith(".map"),
});
console.log(`Copied ${NodePath.relative(appDir, source)} to ${NodePath.relative(appDir, target)}.`);
