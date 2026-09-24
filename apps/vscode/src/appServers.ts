import type { StaticServer } from "./staticServer.ts";

export class AppServerClosedError extends Error {
  override readonly name = "AppServerClosedError";
}

interface Slot {
  closed: boolean;
  readonly server: Promise<StaticServer>;
}

/**
 * The static servers of open panels, one per folder. A folder's server starts
 * at most once however many starts overlap, and is closed exactly once, even
 * when its panel closes while the server is still starting. A folder reopened
 * right after closing waits for its old server to let go of the port, so it
 * gets the same origin (and with it the same browser storage) back.
 */
export class AppServers {
  private readonly slots = new Map<string, Slot>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly start: (key: string) => Promise<StaticServer>;

  constructor(start: (key: string) => Promise<StaticServer>) {
    this.start = start;
  }

  /** The folder's server, starting it if needed. */
  get(key: string): Promise<StaticServer> {
    const existing = this.slots.get(key);
    if (existing) return existing.server;

    const previous = this.closing.get(key) ?? Promise.resolve();
    const slot: Slot = {
      closed: false,
      server: previous.then(async () => {
        if (slot.closed) throw new AppServerClosedError();
        const server = await this.start(key);
        if (slot.closed) {
          await server.close();
          throw new AppServerClosedError();
        }
        return server;
      }),
    };
    // A failed start is not remembered, so the next get() tries again.
    slot.server.catch(() => {
      if (this.slots.get(key) === slot) this.slots.delete(key);
    });
    this.slots.set(key, slot);
    return slot.server;
  }

  /** Closes the folder's server, now or as soon as it finishes starting. */
  close(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return this.closing.get(key) ?? Promise.resolve();
    this.slots.delete(key);
    slot.closed = true;
    const closing = slot.server.then(
      (server) => server.close(),
      () => undefined,
    );
    this.closing.set(key, closing);
    void closing.then(() => {
      if (this.closing.get(key) === closing) this.closing.delete(key);
    });
    return closing;
  }

  closeAll(): Promise<void> {
    return Promise.all([...this.slots.keys()].map((key) => this.close(key))).then(() => undefined);
  }
}
