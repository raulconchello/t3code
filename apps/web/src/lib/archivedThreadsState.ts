import { useAtomValue } from "@effect/atom-react";
import {
  type ArchivedSnapshotEntry,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { orchestrationEnvironment } from "../state/orchestration";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { isWorkspaceLocked, lockShellSnapshot, readWorkspaceLock } from "../workspaceLock";

function archivedSnapshotAtom(environmentId: EnvironmentId) {
  return orchestrationEnvironment.archivedShellSnapshot({
    environmentId,
    input: {},
  });
}

// Archived threads outside the workspace lock stay hidden, like live ones.
const lockedArchivedSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const result = get(archivedSnapshotAtom(environmentId));
    const lock = readWorkspaceLock();
    return lock === null
      ? result
      : AsyncResult.map(result, (snapshot) => lockShellSnapshot(snapshot, environmentId, lock));
  }).pipe(Atom.withLabel(`web:archived-thread-snapshot-locked:${environmentId}`)),
);

const archivedSnapshotsAtom = createArchivedThreadSnapshotsAtomFamily({
  getSnapshotAtom: isWorkspaceLocked ? lockedArchivedSnapshotAtom : archivedSnapshotAtom,
  labelPrefix: "web:archived-thread-snapshots",
});

export function refreshArchivedThreadsForEnvironment(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
}

export function useArchivedThreadSnapshots(environmentIds: ReadonlyArray<EnvironmentId>): {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: () => void;
} {
  const environmentKey = useMemo(
    () => makeArchivedThreadsEnvironmentKey(environmentIds),
    [environmentIds],
  );
  const result = useAtomValue(archivedSnapshotsAtom(environmentKey));
  const refresh = useCallback(() => {
    for (const environmentId of environmentIds) {
      appAtomRegistry.refresh(archivedSnapshotAtom(environmentId));
    }
  }, [environmentIds]);

  return {
    ...result,
    refresh,
  };
}
