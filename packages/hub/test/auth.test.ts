import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  AuthRejected,
  GITHUB_OIDC_ISSUER,
  HubAuth,
  matchesHash,
  newLocalToken,
  tokenKind,
  verifyGithubOidc,
} from "../src/auth.js";

const expected = {
  audience: "tapscout-v2",
  repository: "OzzyD07/TapScout-v2",
  workflowFile: "device-session.yml",
  ref: "refs/heads/main",
};

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

function claims(over: Record<string, unknown> = {}) {
  return {
    repository: "OzzyD07/TapScout-v2",
    ref: "refs/heads/main",
    workflow_ref: "OzzyD07/TapScout-v2/.github/workflows/device-session.yml@refs/heads/main",
    event_name: "workflow_dispatch",
    run_id: "123456",
    run_attempt: "1",
    actor: "OzzyD07",
    sha: "abc",
    ...over,
  };
}

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

async function sign(privateKey: PrivateKey, payload: Record<string, unknown>, aud = "tapscout-v2") {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(GITHUB_OIDC_ISSUER)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

describe("GitHub OIDC verification", () => {
  it("accepts this repository's device-session workflow dispatched on main", async () => {
    const { privateKey, jwks } = await keys();
    const token = await sign(privateKey, claims());
    expect(tokenKind(token)).toBe("github_oidc");
    await expect(verifyGithubOidc(token, expected, jwks)).resolves.toMatchObject({
      runId: 123456,
      actor: "OzzyD07",
    });
  });

  it.each([
    ["another repository", { repository: "evil/fork" }],
    [
      "another workflow",
      { workflow_ref: "OzzyD07/TapScout-v2/.github/workflows/ci.yml@refs/heads/main" },
    ],
    ["another ref", { ref: "refs/heads/feature" }],
    ["a pull request", { event_name: "pull_request" }],
  ])("refuses %s", async (_name, over) => {
    const { privateKey, jwks } = await keys();
    const token = await sign(privateKey, claims(over));
    await expect(verifyGithubOidc(token, expected, jwks)).rejects.toBeInstanceOf(AuthRejected);
  });

  it("refuses a token for another audience or signed by another key", async () => {
    const a = await keys();
    const b = await keys();
    await expect(
      verifyGithubOidc(await sign(a.privateKey, claims(), "other"), expected, a.jwks),
    ).rejects.toBeInstanceOf(AuthRejected);
    await expect(
      verifyGithubOidc(await sign(b.privateKey, claims()), expected, a.jwks),
    ).rejects.toBeInstanceOf(AuthRejected);
  });
});

describe("hub session tokens", () => {
  it("issues tokens bound to a session and survives a reload of the secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tapscout-auth-"));
    const auth = await HubAuth.load(dir);
    const token = await auth.issue({ sid: "s1", run: 42 });
    expect(tokenKind(token)).toBe("hub_session");
    const again = await HubAuth.load(dir);
    await expect(again.verify(token)).resolves.toEqual({ sid: "s1", run: 42 });
    const other = await HubAuth.load(await mkdtemp(join(tmpdir(), "tapscout-auth-")));
    await expect(other.verify(token)).rejects.toBeInstanceOf(AuthRejected);
  });

  it("compares local tokens by hash", () => {
    const { token, hash } = newLocalToken();
    expect(tokenKind(token)).toBe("local");
    expect(matchesHash(token, hash)).toBe(true);
    expect(matchesHash(`${token}x`, hash)).toBe(false);
    expect(matchesHash(token, undefined)).toBe(false);
  });
});
