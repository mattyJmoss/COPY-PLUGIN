/**
 * Shared voice delivery pipeline: sanitize → TTS → encrypt → upload.
 *
 * Used by both the inbound `deliver` callback and the outbound adapter.
 */

import { randomUUID } from "node:crypto";
import type { TTSProvider } from "../tts/interface.js";
import { sanitizeForVoice } from "./sanitize.js";
import { generateReplyAudio } from "./audio.js";
import { encryptAudio } from "./crypto.js";
import { uploadMessage } from "./api.js";

export interface DeliverVoiceParams {
  text: string;
  channelId: string;
  friendPublicKey: string;
  privateKey: string;
  apiUrl: string;
  tmpDir: string;
  tts: TTSProvider;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

export async function deliverVoiceReply(params: DeliverVoiceParams): Promise<{
  ok: boolean;
  messageId?: string;
  error?: string;
}> {
  const { channelId, friendPublicKey, privateKey, apiUrl, tmpDir, tts, log, error } = params;
  const tag = randomUUID().slice(0, 8);

  const text = sanitizeForVoice(params.text);
  log?.(`[Copy:${tag}] TTS input: "${text.slice(0, 120)}"`);

  try {
    const audioBytes = await generateReplyAudio(text, tts, tmpDir, tag, log);

    const { ciphertext, nonce } = await encryptAudio(
      new Uint8Array(audioBytes),
      friendPublicKey,
      privateKey,
    );

    const uploadRes = await uploadMessage(apiUrl, channelId, nonce, ciphertext);
    if (uploadRes.ok) {
      log?.(`[Copy:${tag}] Reply delivered`);
      return { ok: true, messageId: uploadRes.data?.messageId };
    }

    const errMsg = uploadRes.error ?? "upload failed";
    error?.(`[Copy:${tag}] Upload failed: ${errMsg}`);
    return { ok: false, error: errMsg };
  } catch (err) {
    const errMsg = String(err);
    error?.(`[Copy:${tag}] Delivery failed: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
}
