/**
 * Copy outbound adapter — delivers proactive/scheduled messages through Copy.
 *
 * All Copy messages are voice: text → TTS → encrypt → upload.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import type { CopyConfig, CoreConfig } from "./types.js";
import { loadKeypair, loadChannels } from "./copy/storage.js";
import { deliverVoiceReply } from "./copy/deliver.js";
import { ChatterboxTTS } from "./tts/chatterbox.js";

const DEFAULT_API_URL = "https://walkie-talkie-api.matt8066.workers.dev";
const DEFAULT_CHATTERBOX_URL = "http://bazzite.local:4123";

function resolveCopyConfig(cfg: CoreConfig): CopyConfig {
  return cfg.channels?.copy ?? {};
}

export const copyOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,

  sendText: async ({ cfg, to, text }) => {
    const copyConfig = resolveCopyConfig(cfg as CoreConfig);
    const dataDir = copyConfig.dataDir ?? join(homedir(), ".openclaw", "extensions", "copy", "data");
    const tmpDir = join(dataDir, "tmp");
    const apiUrl = copyConfig.apiUrl ?? DEFAULT_API_URL;
    const tts = new ChatterboxTTS({
      url: copyConfig.tts?.url ?? DEFAULT_CHATTERBOX_URL,
      params: copyConfig.tts?.params,
    });

    const keypair = await loadKeypair(dataDir);
    if (!keypair) {
      throw new Error("[Copy outbound] No keypair found");
    }

    // `to` is "dm:{friendUserId}" — find the channel for this peer
    const friendUserId = to.replace(/^dm:/, "");
    const { channels } = await loadChannels(dataDir);
    const channel = channels.find((c) => c.friendUserId === friendUserId);
    if (!channel) {
      throw new Error(`[Copy outbound] No channel for peer ${friendUserId}`);
    }

    const result = await deliverVoiceReply({
      text,
      channelId: channel.channelId,
      friendPublicKey: channel.friendPublicKey,
      privateKey: keypair.privateKey,
      apiUrl,
      tmpDir,
      tts,
    });

    return {
      channel: "copy",
      messageId: result.messageId ?? "",
    };
  },

  sendMedia: async (ctx) => {
    // Copy is audio-only — fall back to sendText
    return copyOutbound.sendText!(ctx);
  },
};
