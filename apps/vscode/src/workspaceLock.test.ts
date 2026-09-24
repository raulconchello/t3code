// @effect-diagnostics nodeBuiltinImport:off -- Builds real and symlinked folders on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, it } from "vite-plus/test";

import { workspaceLockFor } from "./workspaceLock.ts";

const sandbox = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-vscode-lock-")),
);
afterAll(() => NodeFS.rmSync(sandbox, { recursive: true, force: true }));

it("locks a plain folder to its resolved path", () => {
  const folder = NodePath.join(sandbox, "project");
  NodeFS.mkdirSync(folder);
  assert.deepEqual(
    workspaceLockFor({ fsPath: `${folder}/`, name: "project", platform: "darwin" }),
    { workspaceRoot: folder, aliases: [], platform: "darwin", label: "project" },
  );
});

it("adds the real path of a symlinked folder as an alias", () => {
  const real = NodePath.join(sandbox, "real-project");
  const link = NodePath.join(sandbox, "linked-project");
  NodeFS.mkdirSync(real);
  NodeFS.symlinkSync(real, link);
  assert.deepEqual(workspaceLockFor({ fsPath: link, name: " ", platform: "linux" }), {
    workspaceRoot: link,
    aliases: [real],
    platform: "linux",
    label: "linked-project",
  });
});
