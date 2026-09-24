import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopAppActivationPlatform } from "./desktopAppActivation.ts";

/**
 * postMessage protocol between the embedded web app (an iframe) and the page
 * hosting it, such as the VS Code extension webview. The frame sends `hello`,
 * the host answers with `init`, then the frame reports `status` and asks the
 * host to open external links.
 */
export const EMBED_HOST_PROTOCOL_VERSION = 1 as const;

/** The folder the embedded app is locked to. */
export const EmbedHostWorkspace = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  /** Other spellings of the same folder, such as its resolved real path. */
  aliases: Schema.Array(TrimmedNonEmptyString),
  platform: DesktopAppActivationPlatform,
  label: TrimmedNonEmptyString,
});
export type EmbedHostWorkspace = typeof EmbedHostWorkspace.Type;

/** Everything the frame needs to register one bearer connection in memory. */
export const EmbedHostEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  bearerToken: TrimmedNonEmptyString,
});
export type EmbedHostEnvironment = typeof EmbedHostEnvironment.Type;

export const EmbedHostHelloMessage = Schema.Struct({
  version: Schema.Literal(EMBED_HOST_PROTOCOL_VERSION),
  type: Schema.Literal("t3code/hello"),
});
export type EmbedHostHelloMessage = typeof EmbedHostHelloMessage.Type;

export const EmbedHostInitMessage = Schema.Struct({
  version: Schema.Literal(EMBED_HOST_PROTOCOL_VERSION),
  type: Schema.Literal("t3code/init"),
  workspace: EmbedHostWorkspace,
  environment: EmbedHostEnvironment,
});
export type EmbedHostInitMessage = typeof EmbedHostInitMessage.Type;

/**
 * - `connecting`: waiting for the environment to connect and stream live state.
 * - `preparing-project`: finding or adding the project for the workspace.
 * - `ready`: the project is open.
 * - `project-missing`: the project was removed after it was ready.
 * - `auth-failed`: the bearer token was rejected; the host should re-pair.
 * - `error`: anything else; `message` says what happened.
 */
export const EmbedHostStatusPhase = Schema.Literals([
  "connecting",
  "preparing-project",
  "ready",
  "project-missing",
  "auth-failed",
  "error",
]);
export type EmbedHostStatusPhase = typeof EmbedHostStatusPhase.Type;

export const EmbedHostStatusMessage = Schema.Struct({
  version: Schema.Literal(EMBED_HOST_PROTOCOL_VERSION),
  type: Schema.Literal("t3code/status"),
  phase: EmbedHostStatusPhase,
  projectId: Schema.optionalKey(ProjectId),
  message: Schema.optionalKey(Schema.String),
});
export type EmbedHostStatusMessage = typeof EmbedHostStatusMessage.Type;

export const EmbedHostOpenExternalMessage = Schema.Struct({
  version: Schema.Literal(EMBED_HOST_PROTOCOL_VERSION),
  type: Schema.Literal("t3code/open-external"),
  url: TrimmedNonEmptyString,
});
export type EmbedHostOpenExternalMessage = typeof EmbedHostOpenExternalMessage.Type;

/** Messages the embedded frame sends to its host. */
export const EmbedFrameToHostMessage = Schema.Union([
  EmbedHostHelloMessage,
  EmbedHostStatusMessage,
  EmbedHostOpenExternalMessage,
]);
export type EmbedFrameToHostMessage = typeof EmbedFrameToHostMessage.Type;
export const isEmbedFrameToHostMessage = Schema.is(EmbedFrameToHostMessage);

/** Messages the host sends to the embedded frame. */
export const EmbedHostToFrameMessage = Schema.Union([EmbedHostInitMessage]);
export type EmbedHostToFrameMessage = typeof EmbedHostToFrameMessage.Type;
export const isEmbedHostToFrameMessage = Schema.is(EmbedHostToFrameMessage);
