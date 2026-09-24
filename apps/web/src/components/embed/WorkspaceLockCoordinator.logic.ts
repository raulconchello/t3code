import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import type { ProjectId } from "@t3tools/contracts";

import type { WorkspaceLockStatus } from "../../hooks/useWorkspaceLock";

export type WorkspaceProjectPreparation =
  | { readonly phase: "idle" }
  | { readonly phase: "running" }
  | { readonly phase: "failed"; readonly message: string };

export interface WorkspaceLockCoordinatorState {
  readonly connection: SupervisorConnectionState;
  /** The locked environment streams live state and has published its server config. */
  readonly live: boolean;
  readonly projectId: ProjectId | null;
  /** The project was seen in live state before, so its absence means it was removed. */
  readonly projectWasReady: boolean;
  readonly preparation: WorkspaceProjectPreparation;
  /** Bumped by "Try again" and "Re-add project". */
  readonly projectRequest: number;
  readonly handledProjectRequest: number;
}

export function resolveWorkspaceLockStatus(
  state: WorkspaceLockCoordinatorState,
): WorkspaceLockStatus {
  const { connection } = state;
  if (connection.phase === "blocked") {
    const message = connection.lastFailure?.message ?? "T3 Code could not connect.";
    return connection.lastFailure?.reason === "authentication"
      ? { phase: "auth-failed", message }
      : { phase: "error", message };
  }
  if (connection.phase !== "connected" || !state.live) return { phase: "connecting" };
  if (state.projectId !== null) return { phase: "ready", projectId: state.projectId };
  if (state.preparation.phase === "failed") {
    return { phase: "error", message: state.preparation.message };
  }
  if (state.preparation.phase === "idle" && state.projectWasReady && !hasNewProjectRequest(state)) {
    return { phase: "project-missing" };
  }
  return { phase: "preparing-project" };
}

function hasNewProjectRequest(state: WorkspaceLockCoordinatorState): boolean {
  return state.projectRequest !== state.handledProjectRequest;
}

/**
 * Runs one task at a time and drops a start while one is in flight, so an
 * effect that runs twice (as StrictMode does) cannot add the project twice.
 * The task reports its own failures.
 */
export function createSingleFlight() {
  let inFlight = false;
  const settle = () => {
    inFlight = false;
  };
  return (task: () => Promise<void>): boolean => {
    if (inFlight) return false;
    inFlight = true;
    void task().then(settle, settle);
    return true;
  };
}

/**
 * Finding or adding the project runs on its own only the first time the
 * environment is live without it. Once it existed, or after a failure, only an
 * explicit request runs it again, so removing the project never re-adds it.
 */
export function shouldPrepareWorkspaceProject(state: WorkspaceLockCoordinatorState): boolean {
  if (state.connection.phase !== "connected" || !state.live || state.projectId !== null) {
    return false;
  }
  if (state.preparation.phase === "running") return false;
  if (hasNewProjectRequest(state)) return true;
  return state.preparation.phase === "idle" && !state.projectWasReady;
}
