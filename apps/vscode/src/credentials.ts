import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
} from "@t3tools/client-runtime/authorization";
import {
  type AuthClientPresentationMetadata,
  AuthStandardClientScopes,
  type EnvironmentId,
} from "@t3tools/contracts";
import { getPairingTokenFromUrl } from "@t3tools/shared/remote";
import * as Result from "effect/Result";

import { describeRemoteError, runRemote } from "./remote.ts";

export const bearerSecretKey = (environmentId: EnvironmentId) => `t3code.bearer.${environmentId}`;

/** The subset of `vscode.SecretStorage` pairing needs. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export type SessionValidity = "valid" | "invalid";

export interface PairingDeps {
  readonly secrets: SecretStore;
  readonly hasConsent: () => boolean;
  readonly recordConsent: () => PromiseLike<void>;
  /** Shows the one-time consent prompt; true when the user allows pairing. */
  readonly askConsent: () => PromiseLike<boolean>;
  readonly mintPairingToken: () => Promise<string>;
  readonly exchange: (credential: string) => Promise<string>;
  readonly validate: (bearerToken: string) => Promise<SessionValidity>;
}

/** Pairing needs consent the user has not given (or declined to give). */
export class PairingConsentError extends Error {
  override readonly name = "PairingConsentError";
}

class PairingExchangeError extends Error {
  override readonly name = "PairingExchangeError";
}

/**
 * Returns a working bearer token for the environment. Reuses the saved one
 * while the server still accepts it; otherwise pairs again through the CLI,
 * asking for consent only the first time. `rejectedToken` is a token the web
 * app just reported as rejected, so it is never handed back.
 */
export async function ensureBearerToken(
  environmentId: EnvironmentId,
  deps: PairingDeps,
  options: { readonly interactive: boolean; readonly rejectedToken?: string },
): Promise<string> {
  const key = bearerSecretKey(environmentId);
  const stored = await deps.secrets.get(key);
  if (stored && stored !== options.rejectedToken && (await deps.validate(stored)) === "valid") {
    return stored;
  }
  if (stored) {
    await deps.secrets.delete(key);
  }

  if (!deps.hasConsent()) {
    if (!options.interactive || !(await deps.askConsent())) {
      throw new PairingConsentError("T3 Code isn't connected to the desktop app yet.");
    }
    await deps.recordConsent();
  }

  const bearerToken = await deps.exchange(await deps.mintPairingToken());
  await deps.secrets.store(key, bearerToken);
  return bearerToken;
}

/** Saves a bearer token obtained from a pasted pairing link or token. */
export async function pairWithPastedCredential(
  environmentId: EnvironmentId,
  credential: string,
  deps: Pick<PairingDeps, "secrets" | "exchange">,
): Promise<string> {
  const bearerToken = await deps.exchange(credential);
  await deps.secrets.store(bearerSecretKey(environmentId), bearerToken);
  return bearerToken;
}

/**
 * The pairing token from a pasted pairing link (`…/pair#token=…`) or a bare
 * token. The link's host is ignored: the token is always exchanged with the
 * local desktop server.
 */
export function pairingCredentialFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    return /\s/.test(trimmed) ? null : trimmed;
  }
  try {
    return getPairingTokenFromUrl(new URL(trimmed));
  } catch {
    return null;
  }
}

const clientOs = (platform: NodeJS.Platform) =>
  platform === "darwin"
    ? "macOS"
    : platform === "win32"
      ? "Windows"
      : platform === "linux"
        ? "Linux"
        : undefined;

const vscodeClientMetadata = (platform: NodeJS.Platform): AuthClientPresentationMetadata => {
  const os = clientOs(platform);
  return { label: "VS Code", deviceType: "desktop", ...(os ? { os } : {}) };
};

/** Exchanges a one-time pairing token for a standard-scope bearer session. */
export async function exchangePairingCredential(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly platform: NodeJS.Platform;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const result = await runRemote(
    bootstrapRemoteBearerSession({
      httpBaseUrl: input.httpBaseUrl,
      credential: input.credential,
      scopes: AuthStandardClientScopes,
      clientMetadata: vscodeClientMetadata(input.platform),
    }),
    input.fetch,
  );
  if (Result.isFailure(result)) {
    throw new PairingExchangeError(
      result.failure._tag === "EnvironmentAuthInvalidError"
        ? "T3 Code rejected the pairing token. It may have expired or already been used."
        : `T3 Code couldn't complete pairing: ${describeRemoteError(result.failure)}`,
    );
  }
  return result.success.access_token;
}

/** Asks the server whether a saved bearer token still works. */
export async function validateBearerToken(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<SessionValidity> {
  const result = await runRemote(
    fetchRemoteSessionState({
      httpBaseUrl: input.httpBaseUrl,
      bearerToken: input.bearerToken,
      timeoutMs: 5_000,
    }),
    input.fetch,
  );
  if (Result.isSuccess(result)) {
    return result.success.authenticated ? "valid" : "invalid";
  }
  if (result.failure._tag === "EnvironmentAuthInvalidError") {
    return "invalid";
  }
  throw new PairingExchangeError(
    `Couldn't check the saved T3 Code session: ${describeRemoteError(result.failure)}`,
  );
}
