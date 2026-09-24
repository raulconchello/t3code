import type { EnvironmentId } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  PairingConsentError,
  type PairingDeps,
  bearerSecretKey,
  ensureBearerToken,
  pairWithPastedCredential,
  pairingCredentialFromInput,
} from "./credentials.ts";

const environmentId = "env-desktop" as EnvironmentId;
const key = bearerSecretKey(environmentId);

/** In-memory pairing dependencies that record what happened. */
const makeDeps = (options: {
  readonly stored?: string;
  readonly consent?: boolean;
  readonly userAllows?: boolean;
  readonly validTokens?: ReadonlyArray<string>;
  readonly validate?: (token: string) => Promise<"valid" | "invalid">;
}) => {
  const secrets = new Map<string, string>(options.stored ? [[key, options.stored]] : []);
  const calls: string[] = [];
  let consent = options.consent ?? false;
  let minted = 0;
  const deps: PairingDeps = {
    secrets: {
      get: async (name) => secrets.get(name),
      store: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => {
        calls.push(`delete ${name}`);
        secrets.delete(name);
      },
    },
    hasConsent: () => consent,
    recordConsent: async () => {
      calls.push("record consent");
      consent = true;
    },
    askConsent: async () => {
      calls.push("ask consent");
      return options.userAllows ?? false;
    },
    mintPairingToken: async () => {
      minted += 1;
      calls.push("mint");
      return `pairing-${minted}`;
    },
    exchange: async (credential) => {
      calls.push(`exchange ${credential}`);
      return `bearer-for-${credential}`;
    },
    validate:
      options.validate ??
      (async (token) => {
        calls.push(`validate ${token}`);
        return options.validTokens?.includes(token) ? "valid" : "invalid";
      }),
  };
  return { deps, calls, secrets };
};

describe("ensureBearerToken", () => {
  it("reuses a saved token the server still accepts", async () => {
    const { deps, calls } = makeDeps({ stored: "saved", validTokens: ["saved"] });
    assert.equal(await ensureBearerToken(environmentId, deps, { interactive: true }), "saved");
    assert.deepEqual(calls, ["validate saved"]);
  });

  it("re-pairs silently once consent is on record", async () => {
    const { deps, calls, secrets } = makeDeps({ stored: "expired", consent: true });
    assert.equal(
      await ensureBearerToken(environmentId, deps, { interactive: false }),
      "bearer-for-pairing-1",
    );
    assert.deepEqual(calls, ["validate expired", `delete ${key}`, "mint", "exchange pairing-1"]);
    assert.equal(secrets.get(key), "bearer-for-pairing-1");
  });

  it("asks once, remembers consent, then pairs", async () => {
    const { deps, calls } = makeDeps({ userAllows: true });
    assert.equal(
      await ensureBearerToken(environmentId, deps, { interactive: true }),
      "bearer-for-pairing-1",
    );
    assert.deepEqual(calls, ["ask consent", "record consent", "mint", "exchange pairing-1"]);
    assert.isTrue(deps.hasConsent());
  });

  it("does not pair when the user declines", async () => {
    const { deps, calls } = makeDeps({ userAllows: false });
    const error = await ensureBearerToken(environmentId, deps, { interactive: true }).catch(
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, PairingConsentError);
    assert.deepEqual(calls, ["ask consent"]);
    assert.isFalse(deps.hasConsent());
  });

  it("never prompts when not interactive", async () => {
    const { deps, calls } = makeDeps({ stored: "expired" });
    const error = await ensureBearerToken(environmentId, deps, { interactive: false }).catch(
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, PairingConsentError);
    assert.deepEqual(calls, ["validate expired", `delete ${key}`]);
  });

  it("never hands back the token the web app just reported as rejected", async () => {
    const { deps, calls } = makeDeps({
      stored: "rejected",
      consent: true,
      validTokens: ["rejected"],
    });
    assert.equal(
      await ensureBearerToken(environmentId, deps, {
        interactive: false,
        rejectedToken: "rejected",
      }),
      "bearer-for-pairing-1",
    );
    assert.notInclude(calls, "validate rejected");
  });

  it("uses a newer saved token when the rejected one was replaced elsewhere", async () => {
    const { deps, calls } = makeDeps({ stored: "newer", consent: true, validTokens: ["newer"] });
    assert.equal(
      await ensureBearerToken(environmentId, deps, { interactive: false, rejectedToken: "older" }),
      "newer",
    );
    assert.notInclude(calls, "mint");
  });

  it("keeps the saved token when the server can't be asked", async () => {
    const { deps, calls, secrets } = makeDeps({
      stored: "saved",
      consent: true,
      validate: async () => {
        throw new Error("connection refused");
      },
    });
    const error = await ensureBearerToken(environmentId, deps, { interactive: false }).catch(
      (cause: unknown) => cause,
    );
    assert.instanceOf(error, Error);
    assert.notInclude(calls, "mint");
    assert.equal(secrets.get(key), "saved");
  });
});

describe("pairWithPastedCredential", () => {
  it("exchanges the pasted token and saves the session", async () => {
    const { deps, secrets, calls } = makeDeps({});
    assert.equal(
      await pairWithPastedCredential(environmentId, "pasted", deps),
      "bearer-for-pasted",
    );
    assert.equal(secrets.get(key), "bearer-for-pasted");
    assert.notInclude(calls, "record consent");
  });
});

describe("pairingCredentialFromInput", () => {
  it("takes the token from pairing links and ignores their host", () => {
    assert.equal(pairingCredentialFromInput("http://192.168.1.4:3773/pair#token=ABCD"), "ABCD");
    assert.equal(
      pairingCredentialFromInput(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fbox.ts.net#token=WXYZ",
      ),
      "WXYZ",
    );
    assert.equal(pairingCredentialFromInput(" http://localhost:3773/pair?token=QRST "), "QRST");
  });

  it("accepts a bare token", () => {
    assert.equal(pairingCredentialFromInput("  ABCD-EFGH  "), "ABCD-EFGH");
  });

  it("rejects input without a token", () => {
    assert.isNull(pairingCredentialFromInput(""));
    assert.isNull(pairingCredentialFromInput("http://127.0.0.1:3773/pair"));
    assert.isNull(pairingCredentialFromInput("two words"));
  });
});
