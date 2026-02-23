/**
 * Outbound adapter for Copy channel.
 *
 * Handles proactive message sending: text → TTS → encrypt → upload to Copy.
 */

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { getCopyRuntime } from "./runtime.js";
import { loadChannels, loadKeypair } from "./copy/storage.js";
import { encryptAudio } from "./copy/crypto.js";
import { uploadMessage } from "./copy/api.js";
import { generateReplyAudio } from "./copy/audio.js";
import { createTTSProvider, resolveDataDir, resolveTmpDir, resolveApiUrl } from "./channel.js";
import type { CoreConfig } from "./types.js";

export const copyOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",

  // No text chunking — audio messages are sent whole
  chunkerMode: "plain" as any,
  textChunkLimit: 10000,

  sendText: async ({ to, text, accountId }) => {
    const core = getCopyRuntime();
    const cfg = core.config.loadConfig() as CoreConfig;
    const copyConfig = cfg.channels?.copy ?? {};

    const dataDir = resolveDataDir(copyConfig.dataDir);
    const tmpDir = resolveTmpDir(dataDir);
    const apiUrl = resolveApiUrl(copyConfig.apiUrl);

    // Resolve channel from "to" target
    const channelId = to.replace(/^channel:/, "");
    const { channels } = await loadChannels(dataDir);
    const channel = channels.find((c) => c.channelId === channelId);

    if (!channel) {
      throw new Error(`No channel info for target: ${to}`);
    }

    const keypair = await loadKeypair(dataDir);
    if (!keypair) {
      throw new Error("No keypair found — run the register CLI first");
    }

    // Generate TTS audio
    const tts = createTTSProvider(copyConfig);
    const audioBytes = await generateReplyAudio(text, tts, tmpDir, "outbound");

    // Encrypt
    const { ciphertext, nonce } = await encryptAudio(
      new Uint8Array(audioBytes),
      channel.friendPublicKey,
      keypair.privateKey,
    );

    // Upload
    const result = await uploadMessage(apiUrl, channelId, nonce, ciphertext);

    return {
      channel: "copy",
      messageId: result.data?.messageId ?? ("unknown" as any),
      roomId: channelId,
    };
  },

  sendMedia: async ({ to, text, mediaUrl, accountId }) => {
    // Copy only supports audio messages — send text as audio if provided
    if (text?.trim()) {
      return copyOutbound.sendText!({ to, text, accountId } as any);
    }
    throw new Error("Copy channel only supports audio (voice) messages");
  },
};
