import { useAtomValue } from "@effect/atom-react";
import type { EmbedHostStatusPhase, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "../state/projects";
import { environmentShell } from "../state/shell";
import {
  findLockedProject,
  isWorkspaceLocked,
  readWorkspaceLock,
  type WorkspaceLock,
} from "../workspaceLock";

export interface WorkspaceLockStatus {
  readonly phase: EmbedHostStatusPhase;
  readonly projectId?: ProjectId;
  readonly message?: string;
}

export interface WorkspaceLockView {
  readonly lock: WorkspaceLock;
  /** The workspace's project, or null until it exists in a loaded snapshot. */
  readonly projectRef: ScopedProjectRef | null;
  /** Every project in the lock, or null until the locked environment has a snapshot. */
  readonly projectIds: ReadonlySet<ProjectId> | null;
  /** What WorkspaceLockCoordinator is doing; the host gets the same status. */
  readonly status: WorkspaceLockStatus;
}

interface LockedProjects {
  readonly projectRef: ScopedProjectRef | null;
  readonly projectIds: ReadonlySet<ProjectId> | null;
}

const UNLOADED_LOCKED_PROJECTS: LockedProjects = { projectRef: null, projectIds: null };

// These atoms only compute once rendering reads them, after the host's init.
const lockSnapshotLoadedAtom = Atom.make((get) => {
  const lock = readWorkspaceLock();
  return (
    lock !== null &&
    Option.isSome(get(environmentShell.stateValueAtom(lock.environmentId)).snapshot)
  );
}).pipe(Atom.withLabel("web-workspace-lock-snapshot-loaded"));

// Recomputes only when the locked projects change, not on every thread update.
const lockedProjectsAtom = Atom.make((get): LockedProjects => {
  const lock = readWorkspaceLock();
  if (lock === null || !get(lockSnapshotLoadedAtom)) return UNLOADED_LOCKED_PROJECTS;
  const projects = get(environmentProjects.environmentProjectsAtom(lock.environmentId));
  const project = findLockedProject(projects, lock);
  return {
    projectRef:
      project === null ? null : { environmentId: lock.environmentId, projectId: project.id },
    projectIds: new Set(projects.map((candidate) => candidate.id)),
  };
}).pipe(Atom.withLabel("web-workspace-lock-projects"));

const workspaceLockStatusAtom = Atom.make<WorkspaceLockStatus>({ phase: "connecting" }).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-workspace-lock-status"),
);

const workspaceProjectRequestAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-workspace-lock-project-request"),
);

// Sticky: once the project was ready, its absence means it was removed.
const workspaceProjectWasReadyAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-workspace-lock-project-was-ready"),
);

export function setWorkspaceLockStatus(status: WorkspaceLockStatus): void {
  appAtomRegistry.set(workspaceLockStatusAtom, status);
  if (status.phase === "ready") appAtomRegistry.set(workspaceProjectWasReadyAtom, true);
}

export function useWorkspaceProjectWasReady(): boolean {
  return useAtomValue(workspaceProjectWasReadyAtom);
}

/** Asks the coordinator to find or add the workspace's project again. */
export function requestWorkspaceProject(): void {
  appAtomRegistry.update(workspaceProjectRequestAtom, (request) => request + 1);
}

export function useWorkspaceProjectRequest(): number {
  return useAtomValue(workspaceProjectRequestAtom);
}

const workspaceLockViewAtom = Atom.make((get): WorkspaceLockView | null => {
  const lock = readWorkspaceLock();
  return lock === null
    ? null
    : { lock, ...get(lockedProjectsAtom), status: get(workspaceLockStatusAtom) };
}).pipe(Atom.withLabel("web-workspace-lock-view"));

function useLockedWorkspace(): WorkspaceLockView | null {
  return useAtomValue(workspaceLockViewAtom);
}

function useNoWorkspaceLock(): WorkspaceLockView | null {
  return null;
}

/**
 * The workspace lock with its projects and status, for UI that needs them;
 * plain checks use `isWorkspaceLocked`. The lock is fixed for the page's
 * lifetime, so the implementation is picked once and stock builds subscribe
 * to nothing.
 */
export const useWorkspaceLock = isWorkspaceLocked ? useLockedWorkspace : useNoWorkspaceLock;
