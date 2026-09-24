// @effect-diagnostics nodeBuiltinImport:off -- Runs the desktop app's own CLI with plain Node child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A command that runs the T3 server CLI, before any subcommand arguments. */
export interface ServerCliCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Product names the desktop app has shipped under, most likely first. */
const DESKTOP_APP_BUNDLE_NAMES = ["T3 Code (Alpha).app", "T3 Code.app", "T3 Code (Nightly).app"];

/** Where to look for the desktop app: the setting, then /Applications, then ~/Applications. */
export function desktopAppCandidates(input: {
  readonly setting: string | undefined;
  readonly homeDirectory: string;
}): ReadonlyArray<string> {
  const configured = input.setting?.trim() ?? "";
  const searchDirs = ["/Applications", NodePath.join(input.homeDirectory, "Applications")];
  return [
    ...(configured.length > 0 ? [configured] : []),
    ...searchDirs.flatMap((dir) =>
      DESKTOP_APP_BUNDLE_NAMES.map((name) => NodePath.join(dir, name)),
    ),
  ];
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Reads CFBundleExecutable from an XML Info.plist. */
export function parseBundleExecutable(plist: string): string | null {
  const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  const value = match?.[1]?.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => {
    return XML_ENTITIES[name] ?? "";
  });
  return value && value.trim().length > 0 ? value : null;
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

const readInfoPlist = async (plistPath: string): Promise<string> => {
  const bytes = await NodeFSP.readFile(plistPath);
  if (bytes.subarray(0, 6).toString("latin1") !== "bplist") {
    return bytes.toString("utf8");
  }
  // Binary plists need macOS's own converter.
  const { stdout } = await execFile("plutil", ["-convert", "xml1", "-o", "-", plistPath], {});
  return stdout;
};

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
 * The server CLI bundled inside a desktop app: its Electron binary running
 * `app.asar/apps/server/dist/bin.mjs` as Node (apps/desktop/src/backend/DesktopBackendConfiguration.ts).
 */
export async function resolveDesktopAppCli(appPath: string): Promise<ServerCliCommand | null> {
  const contents = NodePath.join(appPath, "Contents");
  const plist = await readInfoPlist(NodePath.join(contents, "Info.plist")).catch(() => null);
  const executable = plist === null ? null : parseBundleExecutable(plist);
  if (executable === null) {
    return null;
  }
  const binary = NodePath.join(contents, "MacOS", executable);
  const asar = NodePath.join(contents, "Resources", "app.asar");
  if (!(await isFile(binary)) || !(await exists(asar))) {
    return null;
  }
  return { command: binary, args: [NodePath.join(asar, "apps", "server", "dist", "bin.mjs")] };
}

class PairingCliError extends Error {
  override readonly name = "PairingCliError";
}

/** Picks the CLI to mint with: the `t3code.serverCommand` override, else the installed desktop app. */
export async function findServerCli(input: {
  readonly serverCommand: ReadonlyArray<string>;
  readonly desktopAppPath: string | undefined;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
}): Promise<ServerCliCommand> {
  const [command, ...args] = input.serverCommand.filter((part) => part.trim().length > 0);
  if (command !== undefined) {
    return { command, args };
  }
  if (input.platform !== "darwin") {
    throw new PairingCliError(
      "Finding the desktop app automatically works on macOS only. Set t3code.serverCommand, or paste a pairing link with T3 Code: Connect to the Desktop App.",
    );
  }
  for (const candidate of desktopAppCandidates({
    setting: input.desktopAppPath,
    homeDirectory: input.homeDirectory,
  })) {
    const cli = await resolveDesktopAppCli(candidate);
    if (cli !== null) {
      return cli;
    }
  }
  throw new PairingCliError(
    "Couldn't find the T3 Code desktop app in /Applications or ~/Applications. Set t3code.desktopAppPath to where it is installed.",
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

/** Mints a one-time pairing token for `home` with the server CLI. */
export async function mintPairingToken(input: {
  readonly cli: ServerCliCommand;
  readonly home: string;
  readonly timeoutMs?: number;
}): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      input.cli.command,
      [...input.cli.args, ...pairingCreateArgs(input.home)],
      {
        cwd: input.home,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: input.timeoutMs ?? 30_000,
        windowsHide: true,
      },
    ));
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
