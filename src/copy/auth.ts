/**
 * Auth orchestration: challenge → sign → verify → JWT
 */

import { signNonce } from "./crypto.js";
import {
  getChallenge,
  verifyChallenge,
  setSessionToken,
} from "./api.js";
import { saveSession, loadSession } from "./storage.js";
import type { Session } from "../types.js";

/**
 * Full auth flow: request challenge, sign with Ed25519, verify, get JWT.
 */
export async function authenticate(
  apiUrl: string,
  dataDir: string,
  signingPublicKey: string,
  signingPrivateKey: string,
  log?: (msg: string) => void,
): Promise<Session> {
  log?.("Requesting auth challenge...");
  const challengeRes = await getChallenge(apiUrl, signingPublicKey);

  if (!challengeRes.ok || !challengeRes.data?.nonce) {
    throw new Error(`Challenge failed: ${challengeRes.error ?? "unknown error"}`);
  }

  const { nonce } = challengeRes.data;
  const signature = await signNonce(nonce, signingPrivateKey);

  const verifyRes = await verifyChallenge(apiUrl, signingPublicKey, nonce, signature);

  if (!verifyRes.ok || !verifyRes.data?.token) {
    throw new Error(`Auth verify failed: ${verifyRes.error ?? "unknown error"}`);
  }

  const { token, userId, expiresAt } = verifyRes.data;

  await saveSession(dataDir, { token, userId, expiresAt });
  setSessionToken(token);

  log?.(`Authenticated as ${userId}`);
  return { userId, token, expiresAt };
}

/**
 * Load session from disk and activate it, re-authing if expired.
 */
export async function loadOrAuthenticate(
  apiUrl: string,
  dataDir: string,
  signingPublicKey: string,
  signingPrivateKey: string,
  log?: (msg: string) => void,
): Promise<Session> {
  const session = await loadSession(dataDir);

  if (session) {
    setSessionToken(session.token);
    log?.(`Loaded existing session for ${session.userId}`);
    return session;
  }

  log?.("No valid session, re-authenticating...");
  return authenticate(apiUrl, dataDir, signingPublicKey, signingPrivateKey, log);
}

/**
 * Proactive token refresh: checks if current token is expiring within 5 minutes.
 */
export async function ensureValidToken(
  apiUrl: string,
  dataDir: string,
  signingPublicKey: string,
  signingPrivateKey: string,
  log?: (msg: string) => void,
): Promise<Session> {
  const session = await loadSession(dataDir);

  if (session) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (session.expiresAt > nowSeconds + 300) {
      setSessionToken(session.token);
      return session;
    }
    log?.("Token expiring within 5 minutes, refreshing...");
  }

  return authenticate(apiUrl, dataDir, signingPublicKey, signingPrivateKey, log);
}
