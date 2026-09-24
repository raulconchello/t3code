import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentCatalogState,
  enabledEnvironmentIds,
} from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { isHostedStaticApp } from "../hostedPairing";
import {
  isWorkspaceLocked,
  lockShellSnapshot,
  readWorkspaceLock,
  type WorkspaceLock,
} from "../workspaceLock";

const EMPTY_LOCKED_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};

/**
 * Filters every shell state through the workspace lock. The locked atoms are
 * the only source for projects, threads, notifications and the routes, so the
 * app never sees anything outside the lock. Each state is filtered once per
 * upstream change, not per read. `readLock` is called when a state is read,
 * after the host's init has arrived.
 */
export function lockEnvironmentShellAtoms<E>(
  unlockedStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
  readLock: () => WorkspaceLock | null,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: OrchestrationShellSnapshot | null = null;
    return Atom.make((get) => {
      const result = get(unlockedStateAtom(environmentId));
      const lock = readLock();
      const state = Option.getOrNull(AsyncResult.value(result));
      if (lock === null || state === null || Option.isNone(state.snapshot)) return result;
      const snapshot = lockShellSnapshot(state.snapshot.value, environmentId, lock, previous);
      previous = snapshot;
      if (snapshot === state.snapshot.value) return result;
      const locked = { ...state, snapshot: Option.some(snapshot) };
      return AsyncResult.map(result, () => locked);
    }).pipe(Atom.withLabel(`environment-shell-state-locked:${environmentId}`));
  });
  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(stateAtom(environmentId))),
        () => EMPTY_LOCKED_SHELL_STATE,
      ),
    ).pipe(Atom.withLabel(`environment-shell-state-value-locked:${environmentId}`)),
  );
  return { stateAtom, stateValueAtom };
}

const unlockedEnvironmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = isWorkspaceLocked
  ? lockEnvironmentShellAtoms(unlockedEnvironmentShell.stateAtom, readWorkspaceLock)
  : unlockedEnvironmentShell;
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of enabledEnvironmentIds(catalog.value)) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

/** Cached or missing snapshots cannot establish that a saved project no longer exists. */
export function createAllEnvironmentProjectSnapshotsReadyAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly requiresPrimaryEnvironment: boolean;
}) {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    // The persisted catalog can emit before platform discovery registers the
    // primary environment. Neither that gap nor an empty catalog proves absence.
    if (!catalog.isReady || catalog.entries.size === 0) return false;
    if (
      input.requiresPrimaryEnvironment &&
      !Array.from(catalog.entries.values()).some(
        (entry) => entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return false;
    }
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const shell = get(input.shellStateValueAtom(environmentId));
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) return false;
    }
    return true;
  }).pipe(Atom.withLabel("web-all-environment-project-snapshots-ready"));
}

export const allEnvironmentProjectSnapshotsReadyAtom =
  createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: environmentCatalog.catalogValueAtom,
    shellStateValueAtom: environmentShell.stateValueAtom,
    requiresPrimaryEnvironment: !isHostedStaticApp(),
  });
