import type {
  DesktopAppActivationErrorCode,
  DesktopAppActivationFailure,
  DesktopAppActivationPlatform,
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";

export interface DesktopAppActivationProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}

export interface DesktopAppActivationTarget {
  readonly environmentId: EnvironmentId;
  readonly platform: ExecutionEnvironmentPlatformOs;
}

export interface ActivationProjectDependencies {
  readonly getTarget: () => DesktopAppActivationTarget | null;
  readonly findProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => DesktopAppActivationProject | null;
  readonly createProject: (
    environmentId: EnvironmentId,
    workspaceRoot: string,
  ) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
}

export interface DesktopAppActivationDependencies extends ActivationProjectDependencies {
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly threadId: ThreadId } | null>;
}

export interface ActivationProjectRequest {
  readonly workspaceRoot: string;
  /** Other spellings of the same folder; an existing project at any of them is reused. */
  readonly aliases?: ReadonlyArray<string>;
  readonly platform: DesktopAppActivationPlatform;
}

export type ActivationProjectResult =
  | {
      readonly ok: true;
      readonly projectRef: ScopedProjectRef;
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly code: Extract<
        DesktopAppActivationErrorCode,
        "environment-unavailable" | "platform-mismatch" | "project-create-failed"
      >;
      readonly message: string;
    };

function failure(
  requestId: string,
  code: DesktopAppActivationFailure["code"],
  message: string,
): DesktopAppActivationFailure {
  return { version: 1, requestId, ok: false, code, message };
}

function desktopPlatformToEnvironmentOs(
  platform: DesktopAppActivationRequest["platform"],
): ExecutionEnvironmentPlatformOs {
  return platform === "win32" ? "windows" : platform;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Finds the project for a folder on the target environment, or adds it and
 * waits until the client store has it. Callers must pass a live view of the
 * projects: a cached one could add a project that already exists.
 */
export async function ensureActivationProject(
  request: ActivationProjectRequest,
  dependencies: ActivationProjectDependencies,
): Promise<ActivationProjectResult> {
  const target = dependencies.getTarget();
  if (target === null) {
    return {
      ok: false,
      code: "environment-unavailable",
      message: "The desktop app's primary local environment is not connected.",
    };
  }

  const requestPlatform = desktopPlatformToEnvironmentOs(request.platform);
  if (requestPlatform !== target.platform) {
    return {
      ok: false,
      code: "platform-mismatch",
      message: `The command path is for ${requestPlatform}, but the desktop app's primary environment uses ${target.platform}. Cross-platform path mapping is not supported.`,
    };
  }

  for (const workspaceRoot of [request.workspaceRoot, ...(request.aliases ?? [])]) {
    const existing = dependencies.findProject(target.environmentId, workspaceRoot);
    if (existing !== null) {
      return {
        ok: true,
        projectRef: { environmentId: target.environmentId, projectId: existing.id },
        created: false,
      };
    }
  }

  try {
    const projectId = await dependencies.createProject(target.environmentId, request.workspaceRoot);
    const projectRef = { environmentId: target.environmentId, projectId };
    await dependencies.waitForProject(projectRef);
    return { ok: true, projectRef, created: true };
  } catch (error) {
    return {
      ok: false,
      code: "project-create-failed",
      message: errorMessage(error, "T3 Code could not add the project."),
    };
  }
}

export async function handleDesktopAppActivationRequest(
  request: DesktopAppActivationRequest,
  dependencies: DesktopAppActivationDependencies,
): Promise<DesktopAppActivationResponse> {
  const project = await ensureActivationProject(request, dependencies);
  if (!project.ok) {
    return failure(request.requestId, project.code, project.message);
  }
  const { projectId } = project.projectRef;

  try {
    const opened = await dependencies.openThread(project.projectRef);
    if (opened === null) {
      return failure(
        request.requestId,
        "thread-open-failed",
        "T3 Code could not open a new thread for the project.",
      );
    }
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId,
      threadId: opened.threadId,
    };
  } catch (error) {
    return failure(
      request.requestId,
      "thread-open-failed",
      errorMessage(error, "T3 Code could not open a new thread for the project."),
    );
  }
}
