// Runner authentication.
//  1. GitHub runners present a GitHub Actions OIDC token. It is verified against GitHub's JWKS
//     (signature, issuer, audience, expiry) and must come from this repository's device-session
//     workflow on the trusted ref, started by workflow_dispatch. The first verified run is bound
//     to the session; a different run is refused afterwards.
//  2. Local runners present a one-time random token the hub generated for that session.
//  3. Both receive a hub-signed session token (HS256, secret kept in the data dir) used for
//     reconnects, the build download and uploads.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRemoteJWKSet,
  decodeJwt,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const HUB_ISSUER = "tapscout-hub";
const RUNNER_AUDIENCE = "tapscout-runner";

export class AuthRejected extends Error {}

let remoteJwks: JWTVerifyGetKey | undefined;
function githubJwks(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));
  return remoteJwks;
}

export interface OidcExpectation {
  audience: string;
  /** "owner/repo" */
  repository: string;
  /** Workflow file name, e.g. "device-session.yml". */
  workflowFile: string;
  /** Trusted ref, e.g. "refs/heads/main". */
  ref: string;
}

export interface VerifiedWorkflow {
  repository: string;
  runId: number;
  runAttempt: number;
  actor: string;
  sha: string;
}

function claim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0)
    throw new AuthRejected(`missing claim ${name}`);
  return value;
}

export async function verifyGithubOidc(
  token: string,
  expected: OidcExpectation,
  keys: JWTVerifyGetKey = githubJwks(),
): Promise<VerifiedWorkflow> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: expected.audience,
      algorithms: ["RS256"],
      clockTolerance: 30,
    }));
  } catch (error) {
    throw new AuthRejected(`invalid OIDC token: ${(error as Error).message}`);
  }
  const repository = claim(payload, "repository");
  if (repository.toLowerCase() !== expected.repository.toLowerCase()) {
    throw new AuthRejected("repository mismatch");
  }
  const ref = claim(payload, "ref");
  if (ref !== expected.ref) throw new AuthRejected("ref mismatch");
  const workflowRef = claim(payload, "workflow_ref");
  const expectedRef = `${repository}/.github/workflows/${expected.workflowFile}@${expected.ref}`;
  if (workflowRef !== expectedRef) throw new AuthRejected("workflow mismatch");
  if (claim(payload, "event_name") !== "workflow_dispatch") {
    throw new AuthRejected("only workflow_dispatch runs may connect");
  }
  const runId = Number(claim(payload, "run_id"));
  const runAttempt = Number(claim(payload, "run_attempt"));
  if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt)) {
    throw new AuthRejected("invalid run identifiers");
  }
  return {
    repository,
    runId,
    runAttempt,
    actor: claim(payload, "actor"),
    sha: claim(payload, "sha"),
  };
}

export interface SessionTokenClaims {
  sid: string;
  /** GitHub run id bound to the session (absent for local runners). */
  run?: number;
}

export class HubAuth {
  private constructor(private readonly secret: Uint8Array) {}

  static async load(dataDir: string): Promise<HubAuth> {
    const file = join(dataDir, "hub-secret");
    let secret: string;
    try {
      secret = (await readFile(file, "utf8")).trim();
    } catch {
      secret = randomBytes(48).toString("base64url");
      await writeFile(file, `${secret}\n`, { mode: 0o600 });
    }
    return new HubAuth(new TextEncoder().encode(secret));
  }

  async issue(claims: SessionTokenClaims, ttlSeconds = 8 * 3600): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(HUB_ISSUER)
      .setAudience(RUNNER_AUDIENCE)
      .setSubject(claims.sid)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
      .sign(this.secret);
  }

  async verify(token: string): Promise<SessionTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: HUB_ISSUER,
        audience: RUNNER_AUDIENCE,
        algorithms: ["HS256"],
      });
      const sid = payload.sid;
      if (typeof sid !== "string" || payload.sub !== sid) throw new Error("malformed");
      return { sid, ...(typeof payload.run === "number" ? { run: payload.run } : {}) };
    } catch {
      throw new AuthRejected("invalid or expired session token");
    }
  }
}

export type TokenKind = "github_oidc" | "hub_session" | "local";

/** Which verifier a bearer token needs (read without verifying anything). */
export function tokenKind(token: string): TokenKind {
  if (token.split(".").length === 3) {
    try {
      const iss = decodeJwt(token).iss;
      if (iss === GITHUB_OIDC_ISSUER) return "github_oidc";
      if (iss === HUB_ISSUER) return "hub_session";
    } catch {
      // Not a JWT.
    }
  }
  return "local";
}

export function newLocalToken(): { token: string; hash: string } {
  const token = `tsl_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256(token) };
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function matchesHash(token: string, hash: string | undefined): boolean {
  if (!hash) return false;
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return m?.[1] ?? null;
}
