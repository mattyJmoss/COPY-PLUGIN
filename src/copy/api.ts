/**
 * Copy API client — wraps all HTTP calls to the Copy backend.
 */

import type { CopyMessage } from "../types.js";

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

let _sessionToken: string | null = null;

export function setSessionToken(token: string): void {
  _sessionToken = token;
}

export function getSessionToken(): string | null {
  return _sessionToken;
}

async function request<T>(
  apiUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<ApiResponse<T>> {
  const url = `${apiUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const authToken = token ?? _sessionToken;
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json()) as ApiResponse<T>;
  return data;
}

// ── Registration ──

export interface RegisterResult {
  userId: string;
}

export async function register(
  apiUrl: string,
  publicKey: string,
  signingKey: string,
): Promise<ApiResponse<RegisterResult>> {
  return request<RegisterResult>(apiUrl, "POST", "/register", {
    publicKey,
    signingKey,
  });
}

// ── Auth ──

export interface ChallengeResult {
  nonce: string;
}

export async function getChallenge(
  apiUrl: string,
  signingKey: string,
): Promise<ApiResponse<ChallengeResult>> {
  return request<ChallengeResult>(apiUrl, "POST", "/auth/challenge", { signingKey });
}

export interface VerifyResult {
  token: string;
  userId: string;
  expiresAt: number;
}

export async function verifyChallenge(
  apiUrl: string,
  signingKey: string,
  nonce: string,
  signature: string,
): Promise<ApiResponse<VerifyResult>> {
  return request<VerifyResult>(apiUrl, "POST", "/auth/verify", {
    signingKey,
    nonce,
    signature,
  });
}

// ── WebSocket token ──

export interface WsTokenResult {
  token: string;
  expiresIn: number;
}

export async function getWsToken(apiUrl: string): Promise<ApiResponse<WsTokenResult>> {
  return request<WsTokenResult>(apiUrl, "POST", "/ws/token");
}

// ── Pairing ──

export interface PairRedeemResult {
  channelId: string;
  inviterUserId: string;
  inviterPublicKey: string;
  inviterDisplayName: string | null;
}

export async function redeemPairToken(
  apiUrl: string,
  token: string,
  slotNumber?: number,
): Promise<ApiResponse<PairRedeemResult>> {
  return request<PairRedeemResult>(apiUrl, "POST", "/pair/redeem", {
    token,
    ...(slotNumber !== undefined ? { slotNumber } : {}),
  });
}

// ── Profile ──

export interface Profile {
  userId: string;
  publicKey: string;
  signingKey: string;
  displayName?: string;
}

export async function getProfile(apiUrl: string): Promise<ApiResponse<{ profile: Profile }>> {
  return request<{ profile: Profile }>(apiUrl, "GET", "/profile");
}

export async function updateProfile(
  apiUrl: string,
  updates: { displayName?: string },
): Promise<ApiResponse<{ profile: Profile }>> {
  return request<{ profile: Profile }>(apiUrl, "PUT", "/profile", updates);
}

// ── Messages ──

export async function downloadAudio(
  apiUrl: string,
  messageId: string,
  channelId: string,
): Promise<Uint8Array | null> {
  const url = `${apiUrl}/message/${messageId}/audio?channelId=${encodeURIComponent(channelId)}`;
  const res = await fetch(url, {
    headers: _sessionToken ? { Authorization: `Bearer ${_sessionToken}` } : {},
  });

  if (!res.ok) return null;

  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function uploadMessage(
  apiUrl: string,
  channelId: string,
  nonce: string,
  ciphertext: string,
): Promise<ApiResponse<{ messageId: string }>> {
  return request<{ messageId: string }>(apiUrl, "POST", "/message", {
    channelId,
    nonce,
    ciphertext,
  });
}

/** Build the WebSocket URL for a channel. */
export function buildWsUrl(apiUrl: string, channelId: string, wsToken: string): string {
  const base = apiUrl.replace(/^http/, "ws");
  return `${base}/ws/channel/${encodeURIComponent(channelId)}?token=${encodeURIComponent(wsToken)}`;
}
