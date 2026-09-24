import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkspaceLockStatus,
  shouldPrepareWorkspaceProject,
  type WorkspaceLockCoordinatorState,
} from "./WorkspaceLockCoordinator.logic";

const CONNECTED: SupervisorConnectionState = { ...AVAILABLE_CONNECTION_STATE, phase: "connected" };
const PROJECT_ID = ProjectId.make("project");

function state(overrides: Partial<WorkspaceLockCoordinatorState> = {}) {
  return {
    connection: CONNECTED,
    live: true,
    projectId: null,
    projectWasReady: false,
    preparation: { phase: "idle" },
    projectRequest: 0,
    handledProjectRequest: 0,
    ...overrides,
  } satisfies WorkspaceLockCoordinatorState;
}

function blocked(reason: ConnectionBlockedError["reason"]): SupervisorConnectionState {
  return {
    ...AVAILABLE_CONNECTION_STATE,
    phase: "blocked",
    lastFailure: new ConnectionBlockedError({ reason, detail: `blocked: ${reason}` }),
  };
}

describe("workspace lock coordinator", () => {
  it("waits for live state before touching the project", () => {
    const cached = state({ live: false, projectId: PROJECT_ID });

    expect(resolveWorkspaceLockStatus(cached)).toEqual({ phase: "connecting" });
    expect(shouldPrepareWorkspaceProject(state({ live: false }))).toBe(false);
  });

  it("adds the project the first time live state lacks it", () => {
    expect(shouldPrepareWorkspaceProject(state())).toBe(true);
    expect(resolveWorkspaceLockStatus(state())).toEqual({ phase: "preparing-project" });
    expect(shouldPrepareWorkspaceProject(state({ preparation: { phase: "running" } }))).toBe(false);
  });

  it("is ready with the project id once the project is live", () => {
    const ready = state({ projectId: PROJECT_ID });

    expect(resolveWorkspaceLockStatus(ready)).toEqual({ phase: "ready", projectId: PROJECT_ID });
    expect(shouldPrepareWorkspaceProject(ready)).toBe(false);
  });

  it("reports a removed project and re-adds it only on request", () => {
    const missing = state({ projectWasReady: true });

    expect(resolveWorkspaceLockStatus(missing)).toEqual({ phase: "project-missing" });
    expect(shouldPrepareWorkspaceProject(missing)).toBe(false);

    const requested = state({ projectWasReady: true, projectRequest: 1 });
    expect(resolveWorkspaceLockStatus(requested)).toEqual({ phase: "preparing-project" });
    expect(shouldPrepareWorkspaceProject(requested)).toBe(true);
  });

  it("keeps a failure until the user tries again", () => {
    const failed = state({ preparation: { phase: "failed", message: "Path is gone." } });

    expect(resolveWorkspaceLockStatus(failed)).toEqual({
      phase: "error",
      message: "Path is gone.",
    });
    expect(shouldPrepareWorkspaceProject(failed)).toBe(false);
    expect(shouldPrepareWorkspaceProject({ ...failed, projectRequest: 1 })).toBe(true);
  });

  it("tells a rejected credential apart from other blocked connections", () => {
    expect(resolveWorkspaceLockStatus(state({ connection: blocked("authentication") }))).toEqual({
      phase: "auth-failed",
      message: "blocked: authentication",
    });
    expect(resolveWorkspaceLockStatus(state({ connection: blocked("unsupported") }))).toEqual({
      phase: "error",
      message: "blocked: unsupported",
    });
  });
});
