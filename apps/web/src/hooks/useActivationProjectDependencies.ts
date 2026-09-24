import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import type { ActivationProjectDependencies } from "../desktopAppActivation";
import { findProjectByPath, inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { readProjects, waitForProject } from "../state/entities";
import type { EnvironmentPresentation } from "../state/environments";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * What `ensureActivationProject` needs to find or add a project on one
 * environment. The target is only available while that environment is
 * connected and has published its server config.
 */
export function useActivationProjectDependencies(
  environment: EnvironmentPresentation | null,
): ActivationProjectDependencies {
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  return {
    getTarget: () => {
      if (environment?.connection.phase !== "connected" || environment.serverConfig === null) {
        return null;
      }
      return {
        environmentId: environment.environmentId,
        platform: environment.serverConfig.environment.platform.os,
      };
    },
    findProject: (environmentId, workspaceRoot) =>
      findProjectByPath(
        readProjects().filter((project) => project.environmentId === environmentId),
        workspaceRoot,
      ) ?? null,
    createProject: async (environmentId, workspaceRoot) => {
      const projectId = newProjectId();
      const result = await createProject({
        environmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(workspaceRoot),
          workspaceRoot,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        throw error instanceof Error ? error : new Error("T3 Code could not add the project.");
      }
      return projectId;
    },
    waitForProject: async (projectRef) => {
      await waitForProject(projectRef);
    },
  };
}
