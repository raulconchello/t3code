import "vite-plus/test/config";
import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";

import webPackageJson from "../web/package.json" with { type: "json" };

// VS Code provides `vscode` at runtime; everything else, including the
// workspace packages and Effect, is inlined into one CommonJS file.
const isVscodeModule = (id: string) => id === "vscode";
const webVersionDefine = { __T3CODE_WEB_VERSION__: JSON.stringify(webPackageJson.version) };

export default defineConfig({
  define: webVersionDefine,
  run: {
    tasks: {
      build: {
        command: "vp pack && node scripts/copy-web.ts",
        dependsOn: ["@t3tools/web#build:vscode"],
        cache: false,
      },
      package: {
        command: "npx --yes @vscode/vsce@4.0.0 package --no-dependencies",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
  pack: {
    format: "cjs",
    platform: "node",
    target: "node20",
    outDir: "dist",
    dts: false,
    sourcemap: true,
    minify: true,
    clean: false,
    outExtensions: () => ({ js: ".cjs" }),
    outputOptions: { codeSplitting: false },
    entry: ["src/extension.ts"],
    define: webVersionDefine,
    deps: {
      alwaysBundle: (id) => !id.startsWith("node:") && !isVscodeModule(id),
      neverBundle: isVscodeModule,
      onlyBundle: false,
    },
  },
  test: {
    // Unit tests run outside VS Code; the controller tests drive a fake of its API.
    alias: { vscode: NodeURL.fileURLToPath(new URL("./test/fakeVscode.ts", import.meta.url)) },
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
    // Several tests launch real Node child processes, which can be slow on a busy machine.
    testTimeout: 15_000,
  },
});
