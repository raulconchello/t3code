// @effect-diagnostics nodeBuiltinImport:off -- Runs the desktop app's own CLI with plain Node child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A command that runs the T3 server CLI, before any subcommand arguments. */
export interface ServerCliCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The real files that decide what runs; see `pinServerCli`. */
  readonly pinned: ReadonlyArray<string>;
}

/** A CLI whose version matched the server, with its files' identity at that check. */
export interface CheckedServerCli {
  readonly cli: ServerCliCommand;
  readonly identity: string;
}

/**
 * Electron's fs (VS Code's extension host) shows an .asar archive as a
 * synthetic folder with a new inode on every stat. `noAsar` turns that off for
 * one synchronous call; plain Node ignores it.
 */
const withoutAsar = <A>(run: () => A): A => {
  const electronProcess: NodeJS.Process & { noAsar?: boolean | undefined } = process;
  const previous = electronProcess.noAsar;
  electronProcess.noAsar = true;
  try {
    return run();
  } finally {
    electronProcess.noAsar = previous;
  }
};

const realFile = (filePath: string): string | null => {
  try {
    return withoutAsar(() => NodeFS.realpathSync.native(filePath));
  } catch {
    return null;
  }
};

const isPathLike = (value: string) =>
  NodePath.isAbsolute(value) || value.includes("/") || value.includes("\\");

const isExecutableFile = (filePath: string) => {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
};

/** Finds a bare command name on `searchPath` the way a shell would; null if it isn't there. */
function findOnPath(command: string, searchPath: string): string | null {
  // Windows also tries the command with each executable extension.
  const extensions = (process.env.PATHEXT ?? "").split(";").filter(Boolean);
  const names =
    NodePath.extname(command) === ""
      ? [command, ...extensions.map((ext) => command + ext)]
      : [command];
  for (const dir of searchPath.split(NodePath.delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = NodePath.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolves the command (through `searchPath` when it is a bare name) and any
 * file arguments to real paths once, so the version check and the mint launch
 * the same files even if PATH, a symlink or the app bundle changes in between.
 * A bare name that isn't on the path is left as is and fails its version check.
 */
export function pinServerCli(
  command: string,
  args: ReadonlyArray<string>,
  searchPath = process.env.PATH ?? "",
): ServerCliCommand {
  const pinned: string[] = [];
  const pin = (value: string, found: string | null) => {
    const real = found === null ? null : realFile(found);
    if (real === null) return value;
    pinned.push(real);
    return real;
  };
  return {
    command: pin(command, isPathLike(command) ? command : findOnPath(command, searchPath)),
    args: args.map((arg) => pin(arg, isPathLike(arg) ? arg : null)),
    pinned,
  };
}

/** dev, inode, size and mtime of each pinned file; any update to them changes it. */
function cliIdentity(cli: ServerCliCommand): string {
  return cli.pinned
    .map((filePath) => {
      try {
        const stats = withoutAsar(() => NodeFS.statSync(filePath));
        return `${filePath}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
      } catch {
        return `${filePath}:missing`;
      }
    })
    .join("|");
}

/** Product names the desktop app has shipped under, most likely first. */
const DESKTOP_APP_BUNDLE_NAMES = ["T3 Code (Alpha).app", "T3 Code.app", "T3 Code (Nightly).app"];

/**
 * Where to look for the desktop app: the setting, then the app running the
 * server, then /Applications, then ~/Applications.
 */
export function desktopAppCandidates(input: {
  readonly setting: string | undefined;
  readonly runningApp: string | null;
  readonly homeDirectory: string;
}): ReadonlyArray<string> {
  const configured = input.setting?.trim() ?? "";
  const searchDirs = ["/Applications", NodePath.join(input.homeDirectory, "Applications")];
  const candidates = [
    ...(configured.length > 0 ? [configured] : []),
    ...(input.runningApp ? [input.runningApp] : []),
    ...searchDirs.flatMap((dir) =>
      DESKTOP_APP_BUNDLE_NAMES.map((name) => NodePath.join(dir, name)),
    ),
  ];
  return [...new Set(candidates.map((candidate) => NodePath.resolve(candidate)))];
}

const execFile = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.ExecFileOptions,
) =>
  new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      args,
      { ...options, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout: String(stdout), stderr: String(stderr) }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** The `.app` bundle an executable belongs to, if it is a macOS app's main binary. */
export function appBundleOfExecutable(executablePath: string): string | null {
  const match = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath.trim());
  return match?.[1] ?? null;
}

/** The app bundle running a process (the desktop app runs its server with its own binary). */
async function runningAppBundle(pid: number): Promise<string | null> {
  const output = await execFile("ps", ["-ww", "-o", "comm=", "-p", String(pid)], {}).catch(
    () => null,
  );
  return output === null ? null : appBundleOfExecutable(output.stdout);
}

const isFile = async (filePath: string) =>
  NodeFSP.stat(filePath).then(
    (stats) => stats.isFile(),
    () => false,
  );

// VS Code's extension host runs on Electron, whose fs shows an .asar archive
// as a directory; plain Node sees a file. Either means it is there.
const exists = async (filePath: string) =>
  NodeFSP.stat(filePath).then(
    () => true,
    () => false,
  );

/**
 * The server CLI bundled inside a desktop app: its Electron binary (named by
 * CFBundleExecutable) running `app.asar/apps/server/dist/bin.mjs` as Node
 * (apps/desktop/src/backend/DesktopBackendConfiguration.ts). macOS only.
 */
export async function resolveDesktopAppCli(appPath: string): Promise<ServerCliCommand | null> {
  const contents = NodePath.join(appPath, "Contents");
  const plist = await execFile(
    "plutil",
    ["-extract", "CFBundleExecutable", "raw", "-o", "-", NodePath.join(contents, "Info.plist")],
    {},
  ).catch(() => null);
  const executable = plist?.stdout.trim();
  if (!executable) {
    return null;
  }
  const binary = realFile(NodePath.join(contents, "MacOS", executable));
  const asar = realFile(NodePath.join(contents, "Resources", "app.asar"));
  if (binary === null || asar === null || !(await isFile(binary)) || !(await exists(asar))) {
    return null;
  }
  return {
    command: binary,
    args: [NodePath.join(asar, "apps", "server", "dist", "bin.mjs")],
    pinned: [binary, asar],
  };
}

class PairingCliError extends Error {
  override readonly name = "PairingCliError";
}

const cliEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" });

/** Parses `t3 --version` output (`t3 v0.0.42`) into the bare version. */
export function parseCliVersionOutput(stdout: string): string | null {
  const lastLine = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  const match = /^\S+\s+v?(\d\S*)$/.exec(lastLine);
  return match?.[1] ?? null;
}

/** Runs `<cli> --version`, which loads no state, and returns the server version it bundles. */
export async function readServerCliVersion(
  cli: ServerCliCommand,
  cwd: string,
): Promise<string | null> {
  const output = await execFile(cli.command, [...cli.args, "--version"], {
    cwd,
    env: cliEnv(),
    timeout: 15_000,
    windowsHide: true,
  }).catch(() => null);
  return output === null ? null : parseCliVersionOutput(output.stdout);
}

const describeVersion = (version: string | null) =>
  version ? `version ${version}` : "an unknown version";

/**
 * Picks the CLI to mint with: the `t3code.serverCommand` override, else a
 * desktop app from `desktopAppCandidates`. Every CLI must bundle exactly the
 * running server's version. `auth pairing create` opens and migrates the T3
 * home's database, so a different version (say Nightly next to Alpha, which
 * share ~/.t3) could migrate the live database under the running server.
 * The result carries the CLI files' identity at the check, which
 * `mintPairingToken` verifies again right before it launches.
 */
export async function findServerCli(input: {
  readonly serverCommand: ReadonlyArray<string>;
  readonly desktopAppPath: string | undefined;
  readonly serverPid: number;
  readonly serverVersion: string;
  readonly home: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly readVersion?: (cli: ServerCliCommand) => Promise<string | null>;
  /** Where a bare serverCommand is looked up; defaults to PATH. */
  readonly searchPath?: string;
}): Promise<CheckedServerCli> {
  const readVersion = input.readVersion ?? ((cli) => readServerCliVersion(cli, input.home));

  const [command, ...args] = input.serverCommand.filter((part) => part.trim().length > 0);
  if (command !== undefined) {
    const cli = pinServerCli(command, args, input.searchPath);
    const identity = cliIdentity(cli);
    const version = await readVersion(cli);
    if (version !== input.serverVersion) {
      throw new PairingCliError(
        `Won't pair with t3code.serverCommand: it is ${describeVersion(version)}, but the running T3 Code server is version ${input.serverVersion}. Fix the setting, or paste a pairing link instead.`,
      );
    }
    return { cli, identity };
  }
  if (input.platform !== "darwin") {
    throw new PairingCliError(
      "Pairing automatically works on macOS only. Paste a pairing link from the T3 Code desktop app instead.",
    );
  }

  const mismatches: string[] = [];
  const candidates = desktopAppCandidates({
    setting: input.desktopAppPath,
    runningApp: await runningAppBundle(input.serverPid),
    homeDirectory: input.homeDirectory,
  });
  for (const candidate of candidates) {
    const cli = await resolveDesktopAppCli(candidate);
    if (cli === null) continue;
    const identity = cliIdentity(cli);
    const version = await readVersion(cli);
    if (version === input.serverVersion) return { cli, identity };
    mismatches.push(`${candidate} is ${describeVersion(version)}`);
  }
  throw new PairingCliError(
    mismatches.length > 0
      ? `No installed T3 Code app matches the running server (version ${input.serverVersion}): ${mismatches.join("; ")}. Paste a pairing link from the desktop app instead.`
      : "Couldn't find the T3 Code desktop app in /Applications or ~/Applications. Set t3code.desktopAppPath to where it is installed, or paste a pairing link.",
  );
}

export const pairingCreateArgs = (home: string): ReadonlyArray<string> => [
  "auth",
  "pairing",
  "create",
  "--base-dir",
  home,
  "--ttl",
  "2m",
  "--label",
  "VS Code",
  "--json",
];

/** `auth pairing create --json` output (apps/server/src/cliAuthFormat.ts). */
const PairingCliOutput = Schema.Struct({
  credential: TrimmedNonEmptyString,
});
const decodePairingCliOutput = Schema.decodeUnknownOption(Schema.fromJsonString(PairingCliOutput));

/** Extracts the one-time pairing credential; tolerates log lines before the JSON. */
export function parsePairingCliOutput(stdout: string): string | null {
  const text = stdout.trim();
  const starts = [0, ...[...text.matchAll(/\n\{/g)].map((match) => match.index + 1)];
  for (const start of starts) {
    const decoded = decodePairingCliOutput(text.slice(start));
    if (Option.isSome(decoded)) {
      return decoded.value.credential;
    }
  }
  return null;
}

const lastLines = (text: string, count: number) =>
  text.trim().split("\n").slice(-count).join("\n").trim();

/**
 * Mints a one-time pairing token for `home` with a checked CLI. Refuses when
 * its files changed since the version check (an app update in between), since
 * the new version could migrate the database.
 */
export async function mintPairingToken(input: {
  readonly cli: CheckedServerCli;
  readonly home: string;
  readonly timeoutMs?: number;
}): Promise<string> {
  const { cli, identity } = input.cli;
  // What remains is a swap between this check and the exec loading the files.
  // macOS replaces an app bundle only after the app quits, when no server runs
  // to pair with, so that window is left open.
  if (cliIdentity(cli) !== identity) {
    throw new PairingCliError(
      "The T3 Code app changed while VS Code was pairing, perhaps because it just updated. Try again, or paste a pairing link from the desktop app.",
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await execFile(cli.command, [...cli.args, ...pairingCreateArgs(input.home)], {
      cwd: input.home,
      env: cliEnv(),
      timeout: input.timeoutMs ?? 30_000,
      windowsHide: true,
    }));
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
    const detail = lastLines(stderr, 3) || (error instanceof Error ? error.message : String(error));
    throw new PairingCliError(`The T3 Code CLI couldn't create a pairing token: ${detail}`);
  }
  const credential = parsePairingCliOutput(stdout);
  if (credential === null) {
    throw new PairingCliError(
      "The T3 Code CLI printed something unexpected while creating a pairing token.",
    );
  }
  return credential;
}
