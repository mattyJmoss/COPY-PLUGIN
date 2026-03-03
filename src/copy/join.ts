/**
 * Copy channel join flow — parse invite URLs and join via API.
 *
 * Supports two link formats:
 * - Pairwise: walkietalkie://pair/{token} (or /pair/{token} or raw 32-hex token)
 * - Group: https://getcopy.app/join/{token}/{base64url_channelSecret}
 */

import type { Keypair, GroupMember, ChannelInfo } from "../types.js";
import { joinGroup, redeemPairToken, uploadSealedKey } from "./api.js";
import { sealChannelSecret } from "./crypto.js";
import { saveChannelSecret, addChannel } from "./storage.js";

// ── Link type detection ──

export type CopyLinkType = "pairwise" | "group";

/**
 * Detect what kind of Copy link this is.
 */
export function detectLinkType(input: string): CopyLinkType | null {
  const trimmed = input.trim();
  if (parsePairLink(trimmed)) return "pairwise";
  if (parseGroupInviteUrl(trimmed)) return "group";
  return null;
}

// ── Pairwise link parsing ──

/**
 * Extract a pair token from various formats:
 * - walkietalkie://pair/{token}
 * - /pair/{token}
 * - https://...//pair/{token}
 * - Raw 32-hex token
 */
export function parsePairLink(input: string): string | null {
  const trimmed = input.trim();

  // URL with /pair/TOKEN path
  const match = trimmed.match(/\/pair\/([0-9a-f]{32})/i);
  if (match) return match[1];

  // Raw 32-hex token
  if (/^[0-9a-f]{32}$/i.test(trimmed)) return trimmed;

  return null;
}

// ── Group invite URL parsing ──

/**
 * Parse a Copy group invite URL.
 * Format: https://getcopy.app/join/{token}/{base64url_channelSecret}
 */
export function parseGroupInviteUrl(
  url: string,
): { token: string; channelSecret: Uint8Array } | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);

    // Expected: ['join', token, channelSecret]
    if (segments.length < 3 || segments[0] !== "join") return null;

    const token = segments[1];
    const secretB64Url = segments[2];

    // Convert base64url to standard base64
    const secretB64 = secretB64Url.replace(/-/g, "+").replace(/_/g, "/");
    const secretBytes = Buffer.from(secretB64, "base64");

    if (secretBytes.length === 0) return null;

    return { token, channelSecret: new Uint8Array(secretBytes) };
  } catch {
    return null;
  }
}

// Keep the old name as an alias for backward compat with tests
export const parseInviteUrl = parseGroupInviteUrl;

// ── Pairwise join ──

/**
 * Join a pairwise (1:1) channel from a pair link.
 *
 * 1. Extract token from link
 * 2. POST /pair/redeem
 * 3. Save channel to channels.json
 */
export async function joinPairwiseFromLink(
  apiUrl: string,
  dataDir: string,
  input: string,
  log?: (msg: string) => void,
): Promise<{ channelId: string; friendName: string }> {
  const token = parsePairLink(input);
  if (!token) {
    throw new Error(`Invalid pair link: ${input}`);
  }

  const result = await redeemPairToken(apiUrl, token, 1);
  if (!result.ok || !result.data) {
    throw new Error(`Pairing failed: ${result.error ?? "unknown error"}`);
  }

  const { channelId, inviterUserId, inviterPublicKey, inviterDisplayName } = result.data;
  log?.(`[Copy:join] Paired with ${inviterDisplayName ?? inviterUserId} on channel ${channelId}`);

  await addChannel(dataDir, {
    channelId,
    channelType: "pairwise",
    friendUserId: inviterUserId,
    friendPublicKey: inviterPublicKey,
    friendDisplayName: inviterDisplayName ?? undefined,
    pairedAt: new Date().toISOString(),
  });

  return { channelId, friendName: inviterDisplayName ?? inviterUserId.slice(0, 8) };
}

// ── Group join ──

/**
 * Join a group channel from an invite URL.
 *
 * 1. Parse invite URL -> token + channelSecret
 * 2. POST /join/{token}
 * 3. Save channelSecret to disk
 * 4. Seal channelSecret for each existing member -> upload
 * 5. Save channel to channels.json
 */
export async function joinGroupFromInvite(
  apiUrl: string,
  dataDir: string,
  inviteUrl: string,
  keypair: Keypair,
  log?: (msg: string) => void,
): Promise<{ channelId: string; members: GroupMember[] }> {
  const parsed = parseGroupInviteUrl(inviteUrl);
  if (!parsed) {
    throw new Error(`Invalid invite URL: ${inviteUrl}`);
  }

  const { token, channelSecret } = parsed;

  // Join via API
  const result = await joinGroup(apiUrl, token);
  if (!result.ok || !result.data) {
    throw new Error(`Join failed: ${result.error ?? "unknown error"}`);
  }

  const { channelId, members, channelName } = result.data;
  log?.(`[Copy:join] Joined group ${channelId} with ${members.length} member(s)`);

  // Save channel secret locally
  await saveChannelSecret(dataDir, channelId, channelSecret);
  log?.(`[Copy:join] Channel secret saved for ${channelId}`);

  // Seal channelSecret for each existing member and upload
  for (const member of members) {
    try {
      const sealed = await sealChannelSecret(channelSecret, member.publicKey);
      await uploadSealedKey(apiUrl, channelId, member.userId, sealed);
      log?.(`[Copy:join] Sealed key uploaded for ${member.displayName ?? member.userId}`);
    } catch (err) {
      log?.(`[Copy:join] WARNING: Failed to upload sealed key for ${member.userId}: ${err}`);
    }
  }

  // Save channel info
  const channel: ChannelInfo = {
    channelId,
    channelType: "group",
    members: [
      ...members,
      {
        userId: "", // Will be set by caller from cachedUserId
        publicKey: keypair.publicKey,
        signingKey: keypair.signingPublicKey,
      },
    ],
    channelName,
    keyVersion: 1,
    pairedAt: new Date().toISOString(),
  };
  await addChannel(dataDir, channel);

  return { channelId, members };
}
