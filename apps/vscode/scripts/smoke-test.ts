// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off -- A manual smoke test runner outside any Effect runtime.
/**
 * Opens the built extension (dist/) in the installed VS Code against a
 * throwaway T3 server started from the installed desktop app's own bundled
 * server, in a fresh temporary T3 home. Never touches ~/.t3.
 *
 *   node scripts/smoke-test.ts
 *
 * The server gets a fake HOME and a PATH without any coding agent CLI, so
 * nothing the test does can start an agent.
 *
 * T3CODE_SMOKE_PORT overrides the server port (38873), T3CODE_SMOKE_VSCODE the VS Code executable, T3CODE_SMOKE_DESKTOP_APP
 * the desktop app, T3CODE_SMOKE_SUITE the suite that runs inside VS Code, and
 * T3CODE_SMOKE_KEEP=1 keeps the temporary directory for inspection.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { runTests } from "@vscode/test-electron";

import {
  type ServerCliCommand,
  desktopAppCandidates,
  resolveDesktopAppCli,
} from "../src/pairingCli.ts";

const SANDBOX_PORT = Number(process.env.T3CODE_SMOKE_PORT ?? 38_873);
const appDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const vscodeExecutable =
  process.env.T3CODE_SMOKE_VSCODE ?? "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const suite = NodePath.resolve(
  process.env.T3CODE_SMOKE_SUITE ?? NodePath.join(appDir, "test", "smoke", "suite.cjs"),
);

for (const required of ["dist/extension.cjs", "dist/web/index.html"]) {
  if (!NodeFS.existsSync(NodePath.join(appDir, required))) {
    console.error(`Missing ${required}. Build the extension first.`);
    process.exit(1);
  }
}

const sandbox = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3vs-")));
// Short names: VS Code puts its IPC socket in the user data dir, and socket paths are length-limited.
const home = NodePath.join(sandbox, "home");
const fakeHome = NodePath.join(sandbox, "fake-home");
const fixture = NodePath.join(sandbox, "fixture-project");
const userDataDir = NodePath.join(sandbox, "udd");
const extensionsDir = NodePath.join(sandbox, "ext");
const liveHome = NodePath.join(NodeOS.homedir(), ".t3");
if (home === liveHome || home.startsWith(`${liveHome}${NodePath.sep}`)) {
  throw new Error(`Refusing to use ${home}: it is inside the live T3 home.`);
}
for (const dir of [home, fakeHome, fixture, NodePath.join(userDataDir, "User"), extensionsDir]) {
  NodeFS.mkdirSync(dir, { recursive: true });
}
NodeFS.writeFileSync(NodePath.join(fixture, "README.md"), "# Smoke test fixture\n");
NodeFS.writeFileSync(
  NodePath.join(userDataDir, "User", "settings.json"),
  JSON.stringify(
    {
      "t3code.homeDir": home,
      "security.workspace.trust.enabled": false,
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "workbench.startupEditor": "none",
      "window.restoreWindows": "none",
    },
    null,
    2,
  ),
);

// The throwaway server can be any installed app: its home is fresh, so nothing is migrated.
// The extension's own pairing then checks the CLI against this server's version.
let cli: ServerCliCommand | null = null;
for (const candidate of desktopAppCandidates({
  setting: process.env.T3CODE_SMOKE_DESKTOP_APP,
  runningApp: null,
  homeDirectory: NodeOS.homedir(),
})) {
  cli ??= await resolveDesktopAppCli(candidate);
}
if (cli === null) {
  console.error("No T3 Code desktop app found to run the sandbox server.");
  process.exit(1);
}
const serverLog = NodeFS.openSync(NodePath.join(sandbox, "server.log"), "a");
const server = NodeChildProcess.spawn(
  cli.command,
  [
    ...cli.args,
    "--mode",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    String(SANDBOX_PORT),
    "--base-dir",
    home,
    "--no-browser",
    "--auto-bootstrap-project-from-cwd=false",
  ],
  {
    cwd: home,
    env: {
      HOME: fakeHome,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: NodeOS.tmpdir(),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", serverLog, serverLog],
  },
);
const serverExited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
console.log(`Sandbox T3 server pid ${server.pid} on port ${SANDBOX_PORT}, home ${home}`);

const waitForRuntimeFile = async () => {
  const runtimeFile = NodePath.join(home, "userdata", "server-runtime.json");
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (server.exitCode !== null) throw new Error("The sandbox T3 server exited early.");
    if (NodeFS.existsSync(runtimeFile) && NodeFS.statSync(runtimeFile).size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The sandbox T3 server did not start within 60 seconds.");
};

let exitCode = 1;
try {
  await waitForRuntimeFile();
  // VS Code must start as itself, not as Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  exitCode = await runTests({
    vscodeExecutablePath: vscodeExecutable,
    extensionDevelopmentPath: appDir,
    extensionTestsPath: suite,
    extensionTestsEnv: { T3CODE_SMOKE_HOME: home },
    launchArgs: [
      fixture,
      "--user-data-dir",
      userDataDir,
      "--extensions-dir",
      extensionsDir,
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
    ],
  });
} catch (error) {
  console.error(error);
} finally {
  server.kill("SIGTERM");
  const stopped = await Promise.race([
    serverExited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!stopped) server.kill("SIGKILL");
  NodeFS.closeSync(serverLog);
  if (process.env.T3CODE_SMOKE_KEEP === "1") {
    console.log(`Kept ${sandbox}`);
  } else {
    NodeFS.rmSync(sandbox, { recursive: true, force: true });
  }
}
console.log(exitCode === 0 ? "Smoke test passed." : "Smoke test failed.");
process.exit(exitCode);
