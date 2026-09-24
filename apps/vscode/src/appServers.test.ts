import { assert, describe, it } from "vite-plus/test";

import { AppServerClosedError, AppServers } from "./appServers.ts";
import type { StaticServer } from "./staticServer.ts";

interface FakeServer extends StaticServer {
  closes: number;
}

type Outcome = { readonly server: FakeServer } | { readonly error: Error };

/** Starts that finish in the order the test releases them, whichever comes first. */
const makeStarts = () => {
  const events: string[] = [];
  const waiting: Array<(outcome: Outcome) => void> = [];
  const released: Outcome[] = [];
  let nextPort = 1;
  let startCount = 0;
  const startWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  /** Resolves once `count` starts have begun. */
  const started = (count: number) =>
    new Promise<void>((resolve) => {
      if (startCount >= count) resolve();
      else startWaiters.push({ count, resolve });
    });
  const settle = (outcome: Outcome) => {
    const resolve = waiting.shift();
    if (resolve) resolve(outcome);
    else released.push(outcome);
  };
  const start = async (key: string) => {
    events.push(`start ${key}`);
    startCount += 1;
    for (const waiter of startWaiters.filter((item) => item.count <= startCount)) {
      startWaiters.splice(startWaiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    const outcome =
      released.shift() ?? (await new Promise<Outcome>((resolve) => waiting.push(resolve)));
    if ("error" in outcome) throw outcome.error;
    return outcome.server;
  };
  const release = () => {
    const port = nextPort++;
    const server: FakeServer = {
      port,
      origin: `http://127.0.0.1:${port}`,
      closes: 0,
      close: async () => {
        server.closes += 1;
        events.push(`close ${port}`);
      },
    };
    settle({ server });
    return server;
  };
  const fail = () => settle({ error: new Error("missing web app") });
  return { start, started, release, fail, events };
};

describe("AppServers", () => {
  it("starts a folder's server once for overlapping starts", async () => {
    const starts = makeStarts();
    const servers = new AppServers(starts.start);
    const first = servers.get("folder");
    const second = servers.get("folder");
    const server = starts.release();
    assert.strictEqual(await first, server);
    assert.strictEqual(await second, server);
    assert.deepEqual(starts.events, ["start folder"]);
  });

  it("closes a server whose panel closed while it was starting", async () => {
    const starts = makeStarts();
    const servers = new AppServers(starts.start);
    const starting = servers.get("folder");
    await starts.started(1);
    const closing = servers.close("folder");
    const server = starts.release();
    const error = await starting.catch((cause: unknown) => cause);
    await closing;
    assert.instanceOf(error, AppServerClosedError);
    assert.equal(server.closes, 1);
  });

  it("never starts a server for a panel that closed first", async () => {
    const starts = makeStarts();
    const servers = new AppServers(starts.start);
    const starting = servers.get("folder");
    await servers.close("folder");
    assert.instanceOf(await starting.catch((cause: unknown) => cause), AppServerClosedError);
    assert.deepEqual(starts.events, []);
  });

  it("closes a running server exactly once", async () => {
    const starts = makeStarts();
    const servers = new AppServers(starts.start);
    const starting = servers.get("folder");
    const server = starts.release();
    await starting;
    await Promise.all([servers.close("folder"), servers.close("folder"), servers.closeAll()]);
    assert.equal(server.closes, 1);
  });

  it("lets a reopened folder start only after its old server let go of the port", async () => {
    const starts = makeStarts();
    const servers = new AppServers(starts.start);
    const starting = servers.get("folder");
    await starts.started(1);
    void servers.close("folder");
    const reopened = servers.get("folder");
    starts.release();
    const second = starts.release();
    await starting.catch(() => undefined);
    assert.strictEqual(await reopened, second);
    assert.deepEqual(starts.events, ["start folder", "close 1", "start folder"]);
  });

  it("tries again after a failed start", async () => {
    const starts = makeStarts();
    const servers = new AppServers(starts.start);
    const failed = servers.get("folder");
    starts.fail();
    assert.instanceOf(await failed.catch((cause: unknown) => cause), Error);
    const retried = servers.get("folder");
    const server = starts.release();
    assert.strictEqual(await retried, server);
    assert.deepEqual(starts.events, ["start folder", "start folder"]);
  });

  it("keeps folders apart", async () => {
    const starts = makeStarts();
    const servers = new AppServers(starts.start);
    const a = servers.get("a");
    const b = servers.get("b");
    const serverA = starts.release();
    const serverB = starts.release();
    assert.strictEqual(await a, serverA);
    assert.strictEqual(await b, serverB);
    await servers.close("a");
    assert.equal(serverA.closes, 1);
    assert.equal(serverB.closes, 0);
  });
});
