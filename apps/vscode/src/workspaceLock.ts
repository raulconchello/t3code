// @effect-diagnostics nodeBuiltinImport:off -- Resolves the folder's real path with plain Node APIs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { EmbedHostWorkspace } from "@t3tools/contracts";

/**
 * The folder a panel is locked to. The root is resolved the way the server
 * CLI resolves one (apps/server/src/cli/app.ts); a symlinked folder also
 * lists its real path, so a project added under either spelling matches.
 */
export function workspaceLockFor(input: {
  readonly fsPath: string;
  readonly name: string;
  readonly platform: EmbedHostWorkspace["platform"];
}): EmbedHostWorkspace {
  const workspaceRoot = NodePath.resolve(input.fsPath);
  let realPath = workspaceRoot;
  try {
    realPath = NodeFS.realpathSync.native(workspaceRoot);
  } catch {
    // A folder that can't be resolved has no other spelling to offer.
  }
  return {
    workspaceRoot,
    aliases: realPath === workspaceRoot ? [] : [realPath],
    platform: input.platform,
    label: input.name.trim() || NodePath.basename(workspaceRoot) || workspaceRoot,
  };
}
