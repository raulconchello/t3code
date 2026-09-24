import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { ensureActivationProject } from "../../desktopAppActivation";
import { reportEmbedHostStatus } from "../../embedHost";
import { useActivationProjectDependencies } from "../../hooks/useActivationProjectDependencies";
import {
  setWorkspaceLockStatus,
  useWorkspaceLock,
  useWorkspaceProjectRequest,
  useWorkspaceProjectWasReady,
  type WorkspaceLockView,
} from "../../hooks/useWorkspaceLock";
import { useEnvironment } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import {
  resolveWorkspaceLockStatus,
  shouldPrepareWorkspaceProject,
  type WorkspaceProjectPreparation,
} from "./WorkspaceLockCoordinator.logic";

// Only the status: the full shell state changes with every thread update.
const shellStatusAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(environmentShell.stateValueAtom(environmentId)).status).pipe(
    Atom.withLabel(`web-workspace-lock-shell-status:${environmentId}`),
  ),
);

/**
 * Keeps an embedded app's workspace lock backed by a project: once the locked
 * environment streams live state it finds or adds the project for the folder,
 * then reports every status change to the host. A cached snapshot never adds a
 * project, and a project removed later is only re-added on request.
 */
export function WorkspaceLockCoordinator() {
  const workspaceLock = useWorkspaceLock();
  return workspaceLock === null ? null : (
    <LockedWorkspaceCoordinator workspaceLock={workspaceLock} />
  );
}

function LockedWorkspaceCoordinator({
  workspaceLock,
}: {
  readonly workspaceLock: WorkspaceLockView;
}) {
  const { lock, projectRef } = workspaceLock;
  const environment = useEnvironment(lock.environmentId);
  const connection = Option.getOrElse(
    AsyncResult.value(useAtomValue(environmentCatalog.stateAtom(lock.environmentId))),
    () => AVAILABLE_CONNECTION_STATE,
  );
  const shellStatus = useAtomValue(shellStatusAtom(lock.environmentId));
  const projectDependencies = useActivationProjectDependencies(environment);
  const projectRequest = useWorkspaceProjectRequest();
  const [handledProjectRequest, setHandledProjectRequest] = useState(projectRequest);
  const [preparation, setPreparation] = useState<WorkspaceProjectPreparation>({ phase: "idle" });
  const projectWasReady = useWorkspaceProjectWasReady();
  // Guards against a second run while one is in flight, including StrictMode's
  // repeated effect.
  const preparingRef = useRef(false);
  const publishedStatusRef = useRef<string | null>(null);

  const state = {
    connection,
    live: shellStatus === "live" && projectDependencies.getTarget() !== null,
    projectId: projectRef?.projectId ?? null,
    projectWasReady,
    preparation,
    projectRequest,
    handledProjectRequest,
  };
  const status = resolveWorkspaceLockStatus(state);
  const shouldPrepare = shouldPrepareWorkspaceProject(state);

  const prepareProject = useEffectEvent(async () => {
    const result = await ensureActivationProject(
      { workspaceRoot: lock.workspaceRoot, aliases: lock.aliases, platform: lock.platform },
      projectDependencies,
    );
    setPreparation(result.ok ? { phase: "idle" } : { phase: "failed", message: result.message });
  });

  useEffect(() => {
    if (!shouldPrepare || preparingRef.current) return;
    preparingRef.current = true;
    setHandledProjectRequest(projectRequest);
    setPreparation({ phase: "running" });
    void prepareProject()
      .catch(() =>
        setPreparation({ phase: "failed", message: "T3 Code could not add the project." }),
      )
      .finally(() => {
        preparingRef.current = false;
      });
  }, [projectRequest, shouldPrepare]);

  useEffect(() => {
    const statusKey = JSON.stringify(status);
    if (publishedStatusRef.current === statusKey) return;
    publishedStatusRef.current = statusKey;
    setWorkspaceLockStatus(status);
    reportEmbedHostStatus(status);
  }, [status]);

  return null;
}
