import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import type * as HttpClient from "effect/unstable/http/HttpClient";

/** Runs one client-runtime HTTP call against a T3 server and returns its result. */
export const runRemote = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Result.Result<A, E>> =>
  Effect.runPromise(effect.pipe(Effect.result, Effect.provide(remoteHttpClientLayer(fetchImpl))));

/** A short, user-facing description of a failed remote call. */
export const describeRemoteError = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && error.message
    ? String(error.message)
    : String(error);
