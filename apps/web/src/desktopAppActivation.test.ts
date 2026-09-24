import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ensureActivationProject,
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    ...overrides,
  };
}

describe("desktop app activation", () => {
  it("reuses an existing project and opens a new thread", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    expect(response).toEqual({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });
});

describe("ensureActivationProject", () => {
  const workspace = { workspaceRoot: "/workspace/project", platform: "linux" } as const;

  it("reuses a project found at an alias without adding one", async () => {
    const deps = dependencies({
      findProject: (_environmentId, workspaceRoot) =>
        workspaceRoot === "/real/project"
          ? { id: existingProjectId, environmentId, workspaceRoot }
          : null,
    });

    const result = await ensureActivationProject(
      { ...workspace, aliases: ["/real/project"] },
      deps,
    );

    expect(result).toEqual({
      ok: true,
      projectRef: { environmentId, projectId: existingProjectId },
      created: false,
    });
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it("adds the project at the root and waits for it", async () => {
    const deps = dependencies({ findProject: () => null });

    const result = await ensureActivationProject(
      { ...workspace, aliases: ["/real/project"] },
      deps,
    );

    expect(deps.createProject).toHaveBeenCalledWith(environmentId, "/workspace/project");
    expect(deps.waitForProject).toHaveBeenCalledWith({
      environmentId,
      projectId: createdProjectId,
    });
    expect(result).toEqual({
      ok: true,
      projectRef: { environmentId, projectId: createdProjectId },
      created: true,
    });
  });

  it("reports a project that never reaches the client store", async () => {
    const result = await ensureActivationProject(
      workspace,
      dependencies({
        findProject: () => null,
        waitForProject: vi.fn(async () => {
          throw new Error("The project did not appear in the desktop app.");
        }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      code: "project-create-failed",
      message: "The project did not appear in the desktop app.",
    });
  });

  it("does nothing while the environment is unavailable", async () => {
    const deps = dependencies({ getTarget: () => null, findProject: () => null });

    const result = await ensureActivationProject(workspace, deps);

    expect(result).toMatchObject({ ok: false, code: "environment-unavailable" });
    expect(deps.createProject).not.toHaveBeenCalled();
  });

  it("maps win32 to a Windows environment", async () => {
    const result = await ensureActivationProject(
      { workspaceRoot: "C:\\workspace\\project", platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "windows" }) }),
    );

    expect(result).toMatchObject({ ok: true, created: false });
  });
});
