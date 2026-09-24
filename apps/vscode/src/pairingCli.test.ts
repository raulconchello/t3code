// @effect-diagnostics nodeBuiltinImport:off -- Builds fake app bundles and CLIs on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, assert, describe, it } from "vite-plus/test";

import {
  type ServerCliCommand,
  appBundleOfExecutable,
  desktopAppCandidates,
  findServerCli,
  mintPairingToken,
  pairingCreateArgs,
  parseCliVersionOutput,
  parsePairingCliOutput,
  pinServerCli,
  readServerCliVersion,
  resolveDesktopAppCli,
} from "./pairingCli.ts";

const isMac = HostProcessPlatform.defaultValue() === "darwin";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tempDir = (prefix: string) => {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
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

/** A minimal .app whose main binary is a hard link to this Node, so it can really run. */
const makeAppBundle = (dir: string, name: string, executable: string) => {
  const app = NodePath.join(dir, name);
  NodeFS.mkdirSync(NodePath.join(app, "Contents", "MacOS"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(app, "Contents", "Resources"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(app, "Contents", "Info.plist"), infoPlist(executable));
  const binary = NodePath.join(app, "Contents", "MacOS", executable);
  try {
    NodeFS.linkSync(NodeFS.realpathSync(process.execPath), binary);
  } catch {
    NodeFS.copyFileSync(process.execPath, binary);
    NodeFS.chmodSync(binary, 0o755);
  }
  NodeFS.writeFileSync(NodePath.join(app, "Contents", "Resources", "app.asar"), "");
  return app;
};

const cliOf = (app: string, executable: string): ServerCliCommand => {
  const binary = NodePath.join(app, "Contents", "MacOS", executable);
  const asar = NodePath.join(app, "Contents", "Resources", "app.asar");
  return {
    command: binary,
    args: [NodePath.join(asar, "apps", "server", "dist", "bin.mjs")],
    pinned: [binary, asar],
  };
};

/** A fake server CLI: answers `--version` and mints, logging each run to `log`. */
const writeFakeCli = (
  filePath: string,
  input: { version: string; credential: string; log: string },
) =>
  NodeFS.writeFileSync(
    filePath,
    `import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(input.log)}, JSON.stringify({ version: ${JSON.stringify(input.version)}, args }) + "\\n");
if (args[0] === "--version") console.log("t3 v${input.version}");
else console.log(JSON.stringify({ id: "pairing-1", credential: ${JSON.stringify(input.credential)} }));
`,
  );

const readLog = (log: string) =>
  NodeFS.readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { version: string; args: string[] });

/** Runs a process from a bundle's binary, like the desktop app runs its server. */
const runFromBundle = (app: string, executable: string) => {
  const child = NodeChildProcess.spawn(
    NodePath.join(app, "Contents", "MacOS", executable),
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  cleanups.push(() => child.kill());
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
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

describe("parseCliVersionOutput", () => {
  it("reads the version `t3 --version` prints", () => {
    assert.equal(parseCliVersionOutput("t3 v0.0.42\n"), "0.0.42");
    assert.equal(
      parseCliVersionOutput("t3 v0.0.43-nightly.20260924.1\n"),
      "0.0.43-nightly.20260924.1",
    );
    assert.isNull(parseCliVersionOutput(""));
    assert.isNull(parseCliVersionOutput("Error: unknown flag --version\nusage: t3"));
  });
});

describe("appBundleOfExecutable", () => {
  it("finds the .app of a main binary only", () => {
    assert.equal(
      appBundleOfExecutable("/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)\n"),
      "/Applications/T3 Code (Alpha).app",
    );
    assert.isNull(appBundleOfExecutable("/usr/local/bin/node"));
    assert.isNull(appBundleOfExecutable("/Applications/T3.app/Contents/Resources/helper"));
  });
});

describe("desktopAppCandidates", () => {
  it("tries the setting, the running app, then /Applications and ~/Applications", () => {
    const candidates = desktopAppCandidates({
      setting: "/Volumes/Apps/T3.app",
      runningApp: "/Users/alice/Applications/T3 Code (Nightly).app",
      homeDirectory: "/Users/alice",
    });
    assert.deepEqual(candidates.slice(0, 4), [
      "/Volumes/Apps/T3.app",
      "/Users/alice/Applications/T3 Code (Nightly).app",
      "/Applications/T3 Code (Alpha).app",
      "/Applications/T3 Code.app",
    ]);
    assert.include(candidates, "/Users/alice/Applications/T3 Code (Alpha).app");
    assert.equal(
      candidates.filter((candidate) => candidate.endsWith("T3 Code (Nightly).app")).length,
      2,
      "the running app is listed once, ahead of the same folder's scan",
    );
  });
});

describe("readServerCliVersion", () => {
  it("runs `--version` as Node and parses the reply", async () => {
    const dir = tempDir("t3code-vscode-version-");
    const record = NodePath.join(dir, "invocation.json");
    const script = NodePath.join(dir, "cli.mjs");
    NodeFS.writeFileSync(
      script,
      `import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE }));
console.log("t3 v9.9.9");
`,
    );
    assert.equal(
      await readServerCliVersion(pinServerCli(process.execPath, [script]), dir),
      "9.9.9",
    );
    assert.deepEqual(JSON.parse(NodeFS.readFileSync(record, "utf8")), {
      args: ["--version"],
      electronRunAsNode: "1",
    });
  });

  it("returns null when the CLI fails", async () => {
    const dir = tempDir("t3code-vscode-version-");
    const script = NodePath.join(dir, "cli.mjs");
    NodeFS.writeFileSync(script, "process.exit(2);");
    assert.isNull(await readServerCliVersion(pinServerCli(process.execPath, [script]), dir));
  });
});

describe("findServerCli", () => {
  const base = {
    desktopAppPath: undefined,
    serverPid: process.pid,
    serverVersion: "0.0.42",
    home: "/tmp/t3-home",
    homeDirectory: "/nowhere",
  };

  it("uses the serverCommand override when it is the server's version", async () => {
    const cli = { command: "node", args: ["/repo/apps/server/dist/bin.mjs"], pinned: [] };
    const checked: ServerCliCommand[] = [];
    const found = await findServerCli({
      ...base,
      serverCommand: [cli.command, ...cli.args],
      platform: "linux",
      readVersion: async (candidate) => {
        checked.push(candidate);
        return "0.0.42";
      },
    });
    assert.deepEqual(found.cli, cli);
    assert.deepEqual(checked, [cli]);
  });

  it("pins the override's files to their real paths", async () => {
    const dir = tempDir("t3code-vscode-pin-");
    const real = NodePath.join(dir, "real-cli.mjs");
    const link = NodePath.join(dir, "cli.mjs");
    NodeFS.writeFileSync(real, "");
    NodeFS.symlinkSync(real, link);
    const found = await findServerCli({
      ...base,
      serverCommand: [process.execPath, link, "--flag"],
      platform: "linux",
      readVersion: async () => "0.0.42",
    });
    assert.deepEqual(found.cli.args, [real, "--flag"]);
    assert.include(found.cli.pinned, real);
  });

  it("refuses a serverCommand of another version", async () => {
    const error = await findServerCli({
      ...base,
      serverCommand: ["node", "/old/bin.mjs"],
      platform: "darwin",
      readVersion: async () => "0.0.41",
    }).catch((cause: unknown) => cause);
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "version 0.0.41");
    assert.include((error as Error).message, "version 0.0.42");
  });

  it("offers pasting a link where it can't look for the app", async () => {
    const error = await findServerCli({
      ...base,
      serverCommand: [],
      platform: "linux",
      readVersion: async () => "0.0.42",
    }).catch((cause: unknown) => cause);
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "Paste a pairing link");
  });

  it.runIf(isMac)(
    "skips an app of another version and uses the one running the server",
    async () => {
      const dir = tempDir("t3code-vscode-apps-");
      const nightly = makeAppBundle(dir, "Nightly.app", "Nightly");
      const alpha = makeAppBundle(dir, "Alpha.app", "Alpha");
      const versions = new Map([
        [cliOf(nightly, "Nightly").command, "0.0.43-nightly"],
        [cliOf(alpha, "Alpha").command, "0.0.42"],
      ]);
      const checked: string[] = [];
      const found = await findServerCli({
        ...base,
        desktopAppPath: nightly,
        serverPid: runFromBundle(alpha, "Alpha"),
        serverCommand: [],
        platform: "darwin",
        readVersion: async (candidate) => {
          checked.push(candidate.command);
          return versions.get(candidate.command) ?? null;
        },
      });
      assert.deepEqual(found.cli, cliOf(alpha, "Alpha"));
      assert.deepEqual(checked, [cliOf(nightly, "Nightly").command, cliOf(alpha, "Alpha").command]);
    },
  );

  it.runIf(isMac)("refuses when no installed app matches the server", async () => {
    const dir = tempDir("t3code-vscode-apps-");
    const stale = makeAppBundle(dir, "Stale.app", "Stale");
    const error = await findServerCli({
      ...base,
      desktopAppPath: stale,
      serverCommand: [],
      platform: "darwin",
      readVersion: async () => "0.0.40",
    }).catch((cause: unknown) => cause);
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, `${stale} is version 0.0.40`);
    assert.include((error as Error).message, "Paste a pairing link");
  });

  it.runIf(isMac)("reads the binary name from Info.plist and needs app.asar", async () => {
    const dir = tempDir("t3code-vscode-apps-");
    const app = makeAppBundle(dir, "Custom T3.app", "T3 Binary");
    assert.deepEqual(await resolveDesktopAppCli(app), cliOf(app, "T3 Binary"));

    const noBinary = makeAppBundle(dir, "NoBinary.app", "Missing");
    NodeFS.rmSync(NodePath.join(noBinary, "Contents", "MacOS", "Missing"));
    const noAsar = makeAppBundle(dir, "NoAsar.app", "T3");
    NodeFS.rmSync(NodePath.join(noAsar, "Contents", "Resources", "app.asar"));
    assert.isNull(await resolveDesktopAppCli(noBinary));
    assert.isNull(await resolveDesktopAppCli(noAsar));
    assert.isNull(await resolveDesktopAppCli(NodePath.join(dir, "Absent.app")));
  });
});

describe("mintPairingToken", () => {
  const checkedFakeCli = (script: string, home: string) =>
    findServerCli({
      serverCommand: [process.execPath, script],
      desktopAppPath: undefined,
      serverPid: process.pid,
      serverVersion: "0.0.42",
      home,
      homeDirectory: "/nowhere",
      platform: "linux",
    });

  it("runs `auth pairing create` against the T3 home as Node and returns the credential", async () => {
    const home = tempDir("t3code-vscode-mint-");
    const script = NodePath.join(home, "fake-cli.mjs");
    const record = NodePath.join(home, "invocation.json");
    NodeFS.writeFileSync(
      script,
      `import * as fs from "node:fs";
if (process.argv[2] === "--version") { console.log("t3 v0.0.42"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE,
}));
process.stdout.write(${JSON.stringify(cliJson)});
`,
    );
    const credential = await mintPairingToken({ cli: await checkedFakeCli(script, home), home });
    assert.equal(credential, "ABCD-EFGH-IJKL");
    const invocation = JSON.parse(NodeFS.readFileSync(record, "utf8"));
    assert.deepEqual(invocation.args, pairingCreateArgs(home));
    assert.equal(NodeFS.realpathSync(invocation.cwd), NodeFS.realpathSync(home));
    assert.equal(invocation.electronRunAsNode, "1");
  });

  it("refuses to mint when the CLI changed after its version check", async () => {
    const home = tempDir("t3code-vscode-mint-");
    const script = NodePath.join(home, "cli.mjs");
    const log = NodePath.join(home, "runs.log");
    writeFakeCli(script, { version: "0.0.42", credential: "OLD", log });
    const checked = await checkedFakeCli(script, home);

    // An update replaces the file in place, the way an app update swaps its bundle.
    const update = NodePath.join(home, "cli.mjs.new");
    writeFakeCli(update, { version: "0.0.43", credential: "NEW", log });
    NodeFS.renameSync(update, script);

    const error = await mintPairingToken({ cli: checked, home }).catch((cause: unknown) => cause);
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "changed");
    assert.deepEqual(readLog(log), [{ version: "0.0.42", args: ["--version"] }]);
  });

  it("launches the checked file even when its path is repointed afterwards", async () => {
    const home = tempDir("t3code-vscode-mint-");
    const log = NodePath.join(home, "runs.log");
    const current = NodePath.join(home, "v42.mjs");
    const next = NodePath.join(home, "v43.mjs");
    const link = NodePath.join(home, "cli.mjs");
    writeFakeCli(current, { version: "0.0.42", credential: "FROM-42", log });
    writeFakeCli(next, { version: "0.0.43", credential: "FROM-43", log });
    NodeFS.symlinkSync(current, link);
    const checked = await checkedFakeCli(link, home);

    NodeFS.rmSync(link);
    NodeFS.symlinkSync(next, link);

    assert.equal(await mintPairingToken({ cli: checked, home }), "FROM-42");
    assert.deepEqual(
      readLog(log).map((run) => run.version),
      ["0.0.42", "0.0.42"],
    );
  });

  it("reports the CLI's error output", async () => {
    const home = tempDir("t3code-vscode-mint-");
    const script = NodePath.join(home, "failing-cli.mjs");
    NodeFS.writeFileSync(
      script,
      `if (process.argv[2] === "--version") { console.log("t3 v0.0.42"); process.exit(0); }
process.stderr.write("database is locked\\n"); process.exit(3);`,
    );
    const error = await mintPairingToken({ cli: await checkedFakeCli(script, home), home }).catch(
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "database is locked");
  });
});
