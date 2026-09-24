import type {
  DesktopAppActivationPlatform,
  EmbedHostInitMessage,
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { readEmbedHost } from "./embedHost";

/**
 * The folder an embedded app is locked to. Under a lock the app only shows and
 * creates the project rooted at that folder, on the host's environment.
 */
export interface WorkspaceLock {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly aliases: ReadonlyArray<string>;
  readonly platform: DesktopAppActivationPlatform;
  /** The folder's display name. */
  readonly label: string;
  /** The root, then its aliases, normalized for comparison. */
  readonly comparablePaths: ReadonlyArray<string>;
}

export function createWorkspaceLock(
  init: Pick<EmbedHostInitMessage, "workspace" | "environment">,
): WorkspaceLock {
  const { workspace, environment } = init;
  const comparablePaths: string[] = [];
  for (const path of [workspace.workspaceRoot, ...workspace.aliases]) {
    const comparable = normalizeProjectPathForComparison(path);
    if (comparable.length > 0 && !comparablePaths.includes(comparable)) {
      comparablePaths.push(comparable);
    }
  }
  return {
    environmentId: environment.environmentId,
    workspaceRoot: workspace.workspaceRoot,
    aliases: workspace.aliases,
    platform: workspace.platform,
    label: workspace.label,
    comparablePaths,
  };
}

let workspaceLock: WorkspaceLock | null = null;

/** The lock for this page, or null outside an embedded build. Stable for the page's lifetime. */
export function readWorkspaceLock(): WorkspaceLock | null {
  if (workspaceLock === null) {
    const embedHost = readEmbedHost();
    if (embedHost !== null) workspaceLock = createWorkspaceLock(embedHost);
  }
  return workspaceLock;
}

function lockPathRank(workspaceRoot: string, lock: WorkspaceLock): number {
  return lock.comparablePaths.indexOf(normalizeProjectPathForComparison(workspaceRoot));
}

export function isProjectInLock(
  project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string },
  lock: WorkspaceLock,
): boolean {
  return (
    project.environmentId === lock.environmentId && lockPathRank(project.workspaceRoot, lock) >= 0
  );
}

/**
 * The project the lock maps to among one environment's projects: one rooted at
 * the workspace root wins over one rooted at an alias.
 */
export function findLockedProject<T extends Pick<OrchestrationProjectShell, "workspaceRoot">>(
  projects: ReadonlyArray<T>,
  lock: WorkspaceLock,
): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const project of projects) {
    const rank = lockPathRank(project.workspaceRoot, lock);
    if (rank >= 0 && rank < bestRank) {
      best = project;
      bestRank = rank;
    }
  }
  return best;
}

const EMPTY_PROJECTS: OrchestrationShellSnapshot["projects"] = Object.freeze([]);
const EMPTY_THREADS: OrchestrationShellSnapshot["threads"] = Object.freeze([]);

/** `previous` when it holds the same items as `next`, so its identity survives. */
function reuseSameItems<T>(
  previous: ReadonlyArray<T> | undefined,
  next: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (previous === undefined || previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index++) {
    if (previous[index] !== next[index]) return next;
  }
  return previous;
}

/**
 * Keeps only the locked projects and their threads. Returns the snapshot
 * itself when nothing is filtered out; otherwise reuses `previous`'s arrays
 * when the kept items did not change, so updates to hidden projects do not
 * ripple through the atoms that read this snapshot. Other environments are
 * emptied.
 */
export function lockShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
  environmentId: EnvironmentId,
  lock: WorkspaceLock,
  previous: OrchestrationShellSnapshot | null = null,
): OrchestrationShellSnapshot {
  if (environmentId !== lock.environmentId) {
    return snapshot.projects.length === 0 && snapshot.threads.length === 0
      ? snapshot
      : { ...snapshot, projects: EMPTY_PROJECTS, threads: EMPTY_THREADS };
  }

  const projects = snapshot.projects.filter(
    (project) => lockPathRank(project.workspaceRoot, lock) >= 0,
  );
  const projectIds = new Set(projects.map((project) => project.id));
  const threads = snapshot.threads.filter((thread) => projectIds.has(thread.projectId));
  if (projects.length === snapshot.projects.length && threads.length === snapshot.threads.length) {
    return snapshot;
  }
  return {
    ...snapshot,
    projects: reuseSameItems(previous?.projects, projects),
    threads: reuseSameItems(previous?.threads, threads),
  };
}

/** Pages that list or add other projects and environments. */
const LOCKED_OUT_PATHS = [
  "/pull-requests",
  "/usage",
  "/welcome",
  "/settings/connections",
  "/pair",
  "/connect",
] as const;

/** Where to send a navigation that would leave the lock, or null to let it through. */
export function resolveLockedRouteRedirect(
  pathname: string,
  lock: WorkspaceLock | null,
): "/" | null {
  if (lock === null) return null;
  const lockedOut = LOCKED_OUT_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  return lockedOut ? "/" : null;
}

/**
 * Whether a thread or draft route points outside the lock. `projectId` is the
 * thread's project when known; `lockedProjectIds` is null until the locked
 * environment has a snapshot, since an unloaded snapshot proves nothing.
 */
export function isThreadRouteOutsideLock(input: {
  readonly lock: WorkspaceLock;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly lockedProjectIds: ReadonlySet<ProjectId> | null;
}): boolean {
  if (input.environmentId !== null && input.environmentId !== input.lock.environmentId) {
    return true;
  }
  return (
    input.projectId !== null &&
    input.lockedProjectIds !== null &&
    !input.lockedProjectIds.has(input.projectId)
  );
}

/**
 * Where a new thread may start under the lock: the requested project when it
 * is inside the lock, otherwise the workspace's own project, or nowhere while
 * that does not exist yet.
 */
export function resolveLockedNewThreadProjectRef(
  requested: ScopedProjectRef,
  lock: WorkspaceLock,
  projects: ReadonlyArray<
    { readonly environmentId: EnvironmentId } & Pick<
      OrchestrationProjectShell,
      "id" | "workspaceRoot"
    >
  >,
): ScopedProjectRef | null {
  const lockedProjects = projects.filter((project) => isProjectInLock(project, lock));
  if (
    lockedProjects.some(
      (project) =>
        project.environmentId === requested.environmentId && project.id === requested.projectId,
    )
  ) {
    return requested;
  }
  const project = findLockedProject(lockedProjects, lock);
  return project === null ? null : { environmentId: project.environmentId, projectId: project.id };
}
