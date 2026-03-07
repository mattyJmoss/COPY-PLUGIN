/**
 * Agent tool: Join a Copy channel from an invite URL.
 *
 * Supports both pairwise (1:1) and group channels.
 * Hot-adds the channel at runtime — no gateway restart needed.
 */

import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { detectLinkType, joinGroupFromInvite, joinPairwiseFromLink } from "../copy/join.js";
import { loadChannelSecret, loadChannels } from "../copy/storage.js";
import { ChannelSocket } from "../copy/websocket.js";
import { getCopyGatewayState } from "../gateway-state.js";

export function createCopyJoinTool(): ChannelAgentTool {
  return {
    name: "copy_join_channel",
    label: "Join Copy Channel",
    ownerOnly: true,
    description:
      "Join a Copy voice channel from an invite URL. " +
      "Supports pairwise 1:1 links (walkietalkie://pair/TOKEN or raw 32-hex token) " +
      "and group invites (https://getcopy.app/join/TOKEN/SECRET). " +
      "The channel starts listening immediately — no restart needed.",
    parameters: Type.Object({
      inviteUrl: Type.String({
        description:
          "The invite URL or pair token. " +
          "Group: https://getcopy.app/join/{token}/{base64url_secret}. " +
          "Pairwise: walkietalkie://pair/{token} or raw 32-hex token.",
      }),
    }),
    async execute(_toolCallId, params) {
      const { inviteUrl } = params as { inviteUrl: string };

      const linkType = detectLinkType(inviteUrl);
      if (!linkType) {
        return {
          content: [{ type: "text" as const, text: "Invalid Copy invite link. Expected a pair token or group invite URL." }],
          details: { ok: false, error: "invalid_link" },
        };
      }

      const state = getCopyGatewayState();
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "Copy gateway is not running. Cannot join channel." }],
          details: { ok: false, error: "gateway_not_running" },
        };
      }

      const { apiUrl, dataDir, keypair, cachedUserId, cachedChannels, channelSecrets, sockets, tokenRefresher, dispatchWsEvent, log } = state;

      try {
        let channelId: string;
        let channelName: string;

        if (linkType === "pairwise") {
          const result = await joinPairwiseFromLink(apiUrl, dataDir, inviteUrl, (msg) => log(msg));
          channelId = result.channelId;
          channelName = result.friendName;
        } else {
          const result = await joinGroupFromInvite(apiUrl, dataDir, inviteUrl, keypair, (msg) => log(msg));
          channelId = result.channelId;
          channelName = `Group (${result.members.length + 1})`;

          // Load and cache the channel secret
          const secret = await loadChannelSecret(dataDir, channelId);
          if (secret) {
            channelSecrets.set(channelId, secret);
          }
        }

        // Reload channels from disk to get the newly saved channel
        const { channels } = await loadChannels(dataDir);
        const newChannel = channels.find((c) => c.channelId === channelId);

        if (newChannel) {
          // Fix self-member userId for group channels
          if (newChannel.channelType === "group" && newChannel.members) {
            const selfMember = newChannel.members.find((m) => m.userId === "");
            if (selfMember) {
              selfMember.userId = cachedUserId;
            }
          }

          // Add to cached channels
          cachedChannels.push(newChannel);

          // Start WebSocket listener immediately
          log(`[Copy:join] Starting live listener for ${channelName} (${channelId.slice(0, 8)}...)`);
          const socket = new ChannelSocket(
            apiUrl,
            channelId,
            (msg) => dispatchWsEvent(msg, channelId),
            tokenRefresher,
            (msg) => log(msg),
          );
          sockets.push(socket);
          await socket.start();

          const pairwise = cachedChannels.filter((c) => (c.channelType ?? "pairwise") === "pairwise").length;
          const groups = cachedChannels.filter((c) => c.channelType === "group").length;
          log(`[Copy:join] Now listening on ${pairwise} pairwise + ${groups} group channel(s)`);

          return {
            content: [{
              type: "text" as const,
              text: `Joined ${linkType} channel "${channelName}" (${channelId.slice(0, 8)}...). ` +
                    `WebSocket connected — listening now. No restart needed.`,
            }],
            details: { ok: true, channelId, type: linkType, name: channelName },
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Joined channel ${channelId} but could not reload channel data. Restart the gateway to start listening.`,
          }],
          details: { ok: true, channelId, type: linkType, needsRestart: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[Copy:join] Failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Join failed: ${msg}` }],
          details: { ok: false, error: msg },
        };
      }
    },
  };
}
