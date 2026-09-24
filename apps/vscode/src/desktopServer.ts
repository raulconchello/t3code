// @effect-diagnostics nodeBuiltinImport:off -- The extension host reads the runtime file with plain Node APIs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { orchestrationProtocolCompatibilityError } from "@t3tools/client-runtime/connection";
import {
  deriveWsBaseUrl,
  fetchRemoteEnvironmentDescriptor,
  normalizeHttpBaseUrl,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { describeRemoteError, runRemote } from "./remote.ts";

/**
 * The part of `<home>/userdata/server-runtime.json` the extension relies on.
 * The running server writes it on start and removes it on stop
 * (apps/server/src/serverRuntimeState.ts).
 */
const ServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  origin: Schema.String,
});
export type ServerRuntimeState = typeof ServerRuntimeState.Type;

const decodeServerRuntimeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(ServerRuntimeState),
);

/** The desktop app's server, checked and ready to pair with. */
export interface DesktopServer {
  readonly home: string;
  /** The server process, from the runtime file. */
  readonly pid: number;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverVersion: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export type DesktopServerDiscovery =
  | { readonly _tag: "Found"; readonly server: DesktopServer }
  | { readonly _tag: "NotRunning"; readonly home: string }
  | { readonly _tag: "Unavailable"; readonly message: string };

/** T3 home: the setting, then `T3CODE_HOME`, then `~/.t3` (same order as the desktop app). */
export function resolveT3Home(input: {
  readonly setting: string | undefined;
  readonly envHome: string | undefined;
  readonly homeDirectory: string;
}): string {
  const raw = input.setting?.trim() || input.envHome?.trim() || "";
  if (raw.length === 0) {
    return NodePath.join(input.homeDirectory, ".t3");
  }
  if (raw === "~") {
    return input.homeDirectory;
  }
  if (raw.startsWith("~/")) {
    return NodePath.join(input.homeDirectory, raw.slice(2));
  }
  return NodePath.resolve(raw);
}

const serverRuntimeStatePath = (home: string) =>
  NodePath.join(home, "userdata", "server-runtime.json");

/** Parses the runtime file; `null` when it is empty or not one we understand. */
export function parseServerRuntimeState(contents: string): ServerRuntimeState | null {
  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return Option.getOrNull(decodeServerRuntimeState(trimmed));
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** Signal 0 only checks that the pid exists; EPERM means it exists under another user. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/**
 * Finds the running desktop server for a T3 home and checks that the bundled
 * web app can talk to it. Never starts anything.
 */
export async function discoverDesktopServer(
  home: string,
  options: {
    readonly isAlive?: (pid: number) => boolean;
    readonly fetch?: typeof globalThis.fetch;
  } = {},
): Promise<DesktopServerDiscovery> {
  let contents: string;
  try {
    contents = await NodeFSP.readFile(serverRuntimeStatePath(home), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { _tag: "NotRunning", home };
    }
    return {
      _tag: "Unavailable",
      message: `Couldn't read ${serverRuntimeStatePath(home)}: ${describeRemoteError(error)}`,
    };
  }

  const state = parseServerRuntimeState(contents);
  if (state === null || !(options.isAlive ?? isProcessAlive)(state.pid)) {
    return { _tag: "NotRunning", home };
  }
  if (!isLoopbackHttpOrigin(state.origin)) {
    return {
      _tag: "Unavailable",
      message: `T3 Code is running at ${state.origin}, which is not a local address on this machine.`,
    };
  }

  const httpBaseUrl = normalizeHttpBaseUrl(state.origin);
  const descriptor = await runRemote(
    fetchRemoteEnvironmentDescriptor({ httpBaseUrl, timeoutMs: 5_000 }),
    options.fetch,
  );
  if (Result.isFailure(descriptor)) {
    return {
      _tag: "Unavailable",
      message: `Couldn't reach T3 Code at ${state.origin}: ${describeRemoteError(descriptor.failure)}`,
    };
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor.success);
  if (compatibilityError !== null) {
    return { _tag: "Unavailable", message: compatibilityError.detail };
  }

  return {
    _tag: "Found",
    server: {
      home,
      pid: state.pid,
      environmentId: descriptor.success.environmentId,
      label: descriptor.success.label,
      serverVersion: descriptor.success.serverVersion,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    },
  };
}

/** A non-blocking warning when the desktop app and the bundled web app differ. */
export function versionSkewWarning(serverVersion: string, webVersion: string): string | null {
  if (serverVersion === webVersion) {
    return null;
  }
  return `The T3 Code desktop app is version ${serverVersion}, but this extension bundles version ${webVersion}. If something looks wrong, update both to the same version.`;
}
