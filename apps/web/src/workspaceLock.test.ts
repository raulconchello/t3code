import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  type AnyRoute,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspaceLock,
  findLockedProject,
  isProjectInLock,
  isThreadRouteOutsideLock,
  lockShellSnapshot,
  resolveLockedNewThreadProjectRef,
  resolveLockedRouteRedirect,
} from "./workspaceLock";

const LOCKED = EnvironmentId.make("locked-environment");
const OTHER = EnvironmentId.make("other-environment");
const NOW = "2026-09-24T00:00:00.000Z";

function lockFor(workspaceRoot: string, aliases: ReadonlyArray<string> = []) {
  return createWorkspaceLock({
    workspace: {
      workspaceRoot,
      aliases,
      platform: workspaceRoot.includes("\\") ? "win32" : "darwin",
      label: "app",
    },
    environment: {
      environmentId: LOCKED,
      label: "Local",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bearerToken: "token",
    },
  });
}

function project(id: string, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function thread(id: string, projectId: string) {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
  } as OrchestrationThreadShell;
}

function snapshot(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot {
  return { snapshotSequence: 1, updatedAt: NOW, projects, threads };
}

describe("workspace lock paths", () => {
  it("matches the root regardless of trailing separators", () => {
    const lock = lockFor("/Users/me/app/");

    expect(isProjectInLock({ environmentId: LOCKED, workspaceRoot: "/Users/me/app" }, lock)).toBe(
      true,
    );
    expect(isProjectInLock({ environmentId: LOCKED, workspaceRoot: "/Users/me/app//" }, lock)).toBe(
      true,
    );
    expect(
      isProjectInLock({ environmentId: LOCKED, workspaceRoot: "/Users/me/app-two" }, lock),
    ).toBe(false);
  });

  it("matches Windows paths across separators and case", () => {
    const lock = lockFor("C:\\Users\\Me\\App\\");

    expect(isProjectInLock({ environmentId: LOCKED, workspaceRoot: "c:/users/me/app" }, lock)).toBe(
      true,
    );
    expect(
      isProjectInLock({ environmentId: LOCKED, workspaceRoot: "C:\\Users\\Me\\Apps" }, lock),
    ).toBe(false);
  });

  it("keeps POSIX paths case-sensitive and matches aliases instead", () => {
    const lock = lockFor("/tmp/app", ["/private/tmp/app"]);

    expect(
      isProjectInLock({ environmentId: LOCKED, workspaceRoot: "/private/tmp/app" }, lock),
    ).toBe(true);
    expect(isProjectInLock({ environmentId: LOCKED, workspaceRoot: "/TMP/app" }, lock)).toBe(false);
  });

  it("ignores projects on other environments", () => {
    expect(
      isProjectInLock({ environmentId: OTHER, workspaceRoot: "/tmp/app" }, lockFor("/tmp/app")),
    ).toBe(false);
  });

  it("drops duplicate spellings of the root from its aliases", () => {
    expect(lockFor("/tmp/app", ["/tmp/app/", "/private/tmp/app"]).comparablePaths).toEqual([
      "/tmp/app",
      "/private/tmp/app",
    ]);
  });

  it("prefers the project at the root over one at an alias", () => {
    const lock = lockFor("/tmp/app", ["/private/tmp/app"]);
    const atAlias = project("at-alias", "/private/tmp/app");
    const atRoot = project("at-root", "/tmp/app/");

    expect(findLockedProject([atAlias, project("other", "/tmp/other"), atRoot], lock)).toBe(atRoot);
    expect(findLockedProject([atAlias], lock)).toBe(atAlias);
    expect(findLockedProject([project("other", "/tmp/other")], lock)).toBeNull();
  });
});

describe("lockShellSnapshot", () => {
  const lock = lockFor("/work/app");
  const app = project("app", "/work/app");
  const other = project("other", "/work/other");

  it("returns the same snapshot when nothing is outside the lock", () => {
    const unfiltered = snapshot([app], [thread("t1", "app")]);

    expect(lockShellSnapshot(unfiltered, LOCKED, lock)).toBe(unfiltered);
  });

  it("keeps only the locked projects and their threads", () => {
    const locked = lockShellSnapshot(
      snapshot([app, other], [thread("t1", "app"), thread("t2", "other"), thread("t3", "app")]),
      LOCKED,
      lock,
    );

    expect(locked.projects).toEqual([app]);
    expect(locked.threads.map((candidate) => candidate.id)).toEqual(["t1", "t3"]);
  });

  it("keeps the previous arrays when only hidden projects changed", () => {
    const appThread = thread("t1", "app");
    const first = lockShellSnapshot(
      snapshot([app, other], [appThread, thread("t2", "other")]),
      LOCKED,
      lock,
    );
    const second = lockShellSnapshot(
      snapshot([app, other], [appThread, thread("t2", "other"), thread("t3", "other")]),
      LOCKED,
      lock,
      first,
    );

    expect(second.projects).toBe(first.projects);
    expect(second.threads).toBe(first.threads);
  });

  it("empties other environments", () => {
    const locked = lockShellSnapshot(snapshot([app], [thread("t1", "app")]), OTHER, lock);
    expect(locked.projects).toEqual([]);
    expect(locked.threads).toEqual([]);

    const empty = snapshot([], []);
    expect(lockShellSnapshot(empty, OTHER, lock)).toBe(empty);
  });
});

describe("locked routes", () => {
  const lock = lockFor("/work/app");

  // A small tree shaped like the app's, so ids and case-insensitive matching
  // come from the real router.
  async function landingPath(pathname: string, routeLock: typeof lock | null = lock) {
    const rootRoute = createRootRoute({
      beforeLoad: ({ matches }) => {
        const target = resolveLockedRouteRedirect(
          matches.map((match) => match.routeId),
          routeLock,
        );
        if (target !== null) throw redirect({ to: target, replace: true });
      },
    });
    const child = (parent: AnyRoute, path: string) =>
      createRoute({ getParentRoute: () => parent, path });
    const settings = child(rootRoute, "settings");
    const chat = createRoute({ getParentRoute: () => rootRoute, id: "_chat" });
    const routeTree = rootRoute.addChildren([
      child(rootRoute, "/"),
      child(rootRoute, "usage"),
      child(rootRoute, "welcome"),
      child(rootRoute, "pair"),
      child(rootRoute, "connect"),
      settings.addChildren(
        ["connections", "diagnostics", "general", "archived"].map((path) => child(settings, path)),
      ),
      chat.addChildren([child(chat, "pull-requests"), child(chat, "draft/$draftId")]),
    ]);
    // Without a document the router runs as on a server: it records each
    // redirect (including its own trailing-slash one) instead of following it.
    let current = pathname;
    for (let hop = 0; hop < 3; hop++) {
      const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [current] }),
      });
      await router.load();
      const next = router.state.redirect?.options.href;
      if (next === undefined) return router.state.location.pathname;
      current = next;
    }
    return current;
  }

  it("sends pages that span projects or environments home, in any letter case", async () => {
    for (const pathname of [
      "/pull-requests",
      "/usage",
      "/Usage",
      "/welcome",
      "/settings/connections",
      "/Settings/Connections",
      "/settings/connections/",
      "/SETTINGS/DIAGNOSTICS",
      "/pair",
      "/connect",
    ]) {
      expect(await landingPath(pathname), pathname).toBe("/");
    }
    for (const pathname of ["/settings/general", "/Settings/Archived", "/draft/d1"]) {
      expect(await landingPath(pathname), pathname).toBe(pathname);
    }
    expect(await landingPath("/Usage", null)).toBe("/Usage");
  });

  it("sends threads on other environments home right away", () => {
    expect(
      isThreadRouteOutsideLock({
        lock,
        environmentId: OTHER,
        projectId: null,
        lockedProjectIds: null,
      }),
    ).toBe(true);
  });

  it("sends threads of other projects home once the snapshot is loaded", () => {
    const route = { lock, environmentId: LOCKED, projectId: ProjectId.make("other") };

    expect(isThreadRouteOutsideLock({ ...route, lockedProjectIds: null })).toBe(false);
    expect(
      isThreadRouteOutsideLock({ ...route, lockedProjectIds: new Set([ProjectId.make("app")]) }),
    ).toBe(true);
    expect(
      isThreadRouteOutsideLock({
        ...route,
        projectId: ProjectId.make("app"),
        lockedProjectIds: new Set([ProjectId.make("app")]),
      }),
    ).toBe(false);
  });
});

describe("resolveLockedNewThreadProjectRef", () => {
  const lock = lockFor("/work/app", ["/real/app"]);
  const scoped = (id: string, workspaceRoot: string, environmentId = LOCKED) => ({
    ...project(id, workspaceRoot),
    environmentId,
  });
  const projects = [
    scoped("alias", "/real/app"),
    scoped("app", "/work/app"),
    scoped("other", "/work/other"),
    scoped("remote-app", "/work/app", OTHER),
  ];
  const appRef = { environmentId: LOCKED, projectId: ProjectId.make("app") };

  it("keeps a requested project inside the lock", () => {
    const aliasRef = { environmentId: LOCKED, projectId: ProjectId.make("alias") };

    expect(resolveLockedNewThreadProjectRef(aliasRef, lock, projects)).toBe(aliasRef);
  });

  it("replaces a project outside the lock with the workspace's own", () => {
    for (const requested of [
      { environmentId: LOCKED, projectId: ProjectId.make("other") },
      { environmentId: OTHER, projectId: ProjectId.make("remote-app") },
    ]) {
      expect(resolveLockedNewThreadProjectRef(requested, lock, projects)).toEqual(appRef);
    }
  });

  it("starts nothing before the workspace's project exists", () => {
    expect(
      resolveLockedNewThreadProjectRef(appRef, lock, [scoped("other", "/work/other")]),
    ).toBeNull();
  });
});
