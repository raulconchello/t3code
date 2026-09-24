// @effect-diagnostics nodeBuiltinImport:off -- Builds fake app bundles and CLIs on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  desktopAppCandidates,
  findServerCli,
  mintPairingToken,
  pairingCreateArgs,
  parseBundleExecutable,
  parsePairingCliOutput,
  resolveDesktopAppCli,
} from "./pairingCli.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tempDir = (prefix: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const infoPlist = (executable: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>T3 Code (Alpha)</string>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
</dict>
</plist>`;

/** A minimal .app with the files the extension looks for. */
const makeAppBundle = (dir: string, name: string, executable: string) => {
  const app = NodePath.join(dir, name);
  NodeFS.mkdirSync(NodePath.join(app, "Contents", "MacOS"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(app, "Contents", "Resources"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(app, "Contents", "Info.plist"), infoPlist(executable));
  NodeFS.writeFileSync(NodePath.join(app, "Contents", "MacOS", executable), "");
  NodeFS.writeFileSync(NodePath.join(app, "Contents", "Resources", "app.asar"), "");
  return app;
};

// What `t3 auth pairing create --json` prints (apps/server/src/cliAuthFormat.ts).
const cliJson = `${JSON.stringify(
  {
    id: "pairing-1",
    credential: "ABCD-EFGH-IJKL",
    label: "VS Code",
    scopes: ["orchestration:read", "orchestration:operate"],
    expiresAt: "2026-09-24T18:00:00.000Z",
  },
  null,
  2,
)}\n`;

describe("parsePairingCliOutput", () => {
  it("reads the credential from the CLI's JSON", () => {
    assert.equal(parsePairingCliOutput(cliJson), "ABCD-EFGH-IJKL");
  });

  it("skips log lines printed before the JSON", () => {
    assert.equal(
      parsePairingCliOutput(`timestamp=… level=WARN message="slow disk" {x}\n${cliJson}`),
      "ABCD-EFGH-IJKL",
    );
  });

  it("returns null when there is no credential", () => {
    assert.isNull(parsePairingCliOutput(""));
    assert.isNull(parsePairingCliOutput("Pairing token: ABCD\n"));
    assert.isNull(parsePairingCliOutput('{"id":"pairing-1","credential":"  "}'));
  });
});

describe("parseBundleExecutable", () => {
  it("reads CFBundleExecutable, decoding XML entities", () => {
    assert.equal(parseBundleExecutable(infoPlist("T3 Code (Alpha)")), "T3 Code (Alpha)");
    assert.equal(parseBundleExecutable(infoPlist("T3 &amp; Co")), "T3 & Co");
    assert.isNull(parseBundleExecutable("<plist><dict></dict></plist>"));
  });
});

describe("desktopAppCandidates", () => {
  it("tries the setting, then /Applications, then ~/Applications", () => {
    const candidates = desktopAppCandidates({
      setting: "/Volumes/Apps/T3.app",
      homeDirectory: "/Users/alice",
    });
    assert.deepEqual(candidates.slice(0, 3), [
      "/Volumes/Apps/T3.app",
      "/Applications/T3 Code (Alpha).app",
      "/Applications/T3 Code.app",
    ]);
    assert.include(candidates, "/Users/alice/Applications/T3 Code (Alpha).app");
    assert.isTrue(
      candidates.indexOf("/Applications/T3 Code.app") <
        candidates.indexOf("/Users/alice/Applications/T3 Code (Alpha).app"),
    );
  });
});

describe("findServerCli", () => {
  it("uses the serverCommand override as is", async () => {
    assert.deepEqual(
      await findServerCli({
        serverCommand: ["node", "/repo/apps/server/dist/bin.mjs"],
        desktopAppPath: undefined,
        homeDirectory: "/Users/alice",
        platform: "linux",
      }),
      { command: "node", args: ["/repo/apps/server/dist/bin.mjs"] },
    );
  });

  it("runs the app's own binary from its Info.plist against app.asar", async () => {
    const dir = tempDir("t3code-vscode-apps-");
    const app = makeAppBundle(dir, "Custom T3.app", "T3 Binary");
    assert.deepEqual(
      await findServerCli({
        serverCommand: [],
        desktopAppPath: app,
        homeDirectory: dir,
        platform: "darwin",
      }),
      {
        command: NodePath.join(app, "Contents", "MacOS", "T3 Binary"),
        args: [NodePath.join(app, "Contents", "Resources", "app.asar", "apps/server/dist/bin.mjs")],
      },
    );
  });

  it("rejects bundles missing their binary or app.asar", async () => {
    const dir = tempDir("t3code-vscode-apps-");
    const noBinary = makeAppBundle(dir, "NoBinary.app", "Missing");
    NodeFS.rmSync(NodePath.join(noBinary, "Contents", "MacOS", "Missing"));
    const noAsar = makeAppBundle(dir, "NoAsar.app", "T3");
    NodeFS.rmSync(NodePath.join(noAsar, "Contents", "Resources", "app.asar"));
    assert.isNull(await resolveDesktopAppCli(noBinary));
    assert.isNull(await resolveDesktopAppCli(noAsar));
    assert.isNull(await resolveDesktopAppCli(NodePath.join(dir, "Absent.app")));
  });

  it("asks for serverCommand where it cannot find the app", async () => {
    const error = await findServerCli({
      serverCommand: [],
      desktopAppPath: undefined,
      homeDirectory: "/nowhere",
      platform: "linux",
    }).catch((cause: unknown) => cause);
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "t3code.serverCommand");
  });
});

describe("mintPairingToken", () => {
  it("runs `auth pairing create` against the T3 home as Node and returns the credential", async () => {
    const home = tempDir("t3code-vscode-mint-");
    const script = NodePath.join(home, "fake-cli.mjs");
    const record = NodePath.join(home, "invocation.json");
    NodeFS.writeFileSync(
      script,
      `import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
}));
process.stdout.write(${JSON.stringify(cliJson)});
`,
    );
    const credential = await mintPairingToken({
      cli: { command: process.execPath, args: [script] },
      home,
    });
    assert.equal(credential, "ABCD-EFGH-IJKL");
    const invocation = JSON.parse(NodeFS.readFileSync(record, "utf8"));
    assert.deepEqual(invocation.args, pairingCreateArgs(home));
    assert.equal(NodeFS.realpathSync(invocation.cwd), NodeFS.realpathSync(home));
    assert.equal(invocation.electronRunAsNode, "1");
  });

  it("reports the CLI's error output", async () => {
    const home = tempDir("t3code-vscode-mint-");
    const script = NodePath.join(home, "failing-cli.mjs");
    NodeFS.writeFileSync(script, `process.stderr.write("database is locked\\n"); process.exit(3);`);
    const error = await mintPairingToken({
      cli: { command: process.execPath, args: [script] },
      home,
    }).catch((cause: unknown) => cause);
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "database is locked");
  });
});
