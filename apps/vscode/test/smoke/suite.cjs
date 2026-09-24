// Runs inside VS Code, started by scripts/smoke-test.ts. Opens T3 Code for the
// fixture folder, waits for the web app to report ready, then reloads it.
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms)),
  ]);

exports.run = async () => {
  const home = vscode.workspace.getConfiguration("t3code").get("homeDir");
  assert.equal(home, process.env.T3CODE_SMOKE_HOME, "t3code.homeDir must be the smoke sandbox");
  const liveHome = path.join(os.homedir(), ".t3");
  assert.ok(!path.resolve(home).startsWith(liveHome), "refusing to run against ~/.t3");

  const api = await vscode.extensions.getExtension("t3tools.t3code-vscode").activate();
  assert.ok(api, "the extension exposes its test API outside production");
  await api.setPairingConsent(true);

  const [folder] = vscode.workspace.workspaceFolders ?? [];
  assert.ok(folder, "the fixture folder is open");
  const key = folder.uri.toString();

  const ready = api.waitForStatus(key, "ready");
  await vscode.commands.executeCommand("t3code.open");
  const status = await withTimeout(ready, 120_000, "ready");
  console.log(`[smoke] ready: ${status.message ?? ""}`);

  await vscode.commands.executeCommand("t3code.reload");
  await withTimeout(api.waitForStatus(key, "ready"), 120_000, "ready after reload");
  console.log("[smoke] ready after reload");
};
