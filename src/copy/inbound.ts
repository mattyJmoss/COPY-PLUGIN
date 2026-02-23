/**
 * Inbound message processing for Copy.
 *
 * Handles the full pipeline:
 *   WS event → download → decrypt → STT → OpenClaw pipeline → TTS → encrypt → upload
 */

import { randomUUID } from "node:crypto";
import {
  createReplyPrefixOptions,
  type PluginRuntime,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type {
  CopyConfig,
  CopyMessage,
  CopyWsEvent,
  ChannelInfo,
  Keypair,
  CoreConfig,
  DEFAULT_VOICE_PROMPT,
} from "../types.js";
import { DEFAULT_VOICE_PROMPT as VOICE_PROMPT } from "../types.js";
import { downloadAudio, uploadMessage } from "./api.js";
import { decryptAudioRaw, decryptAudio, encryptAudio } from "./crypto.js";
import { readUserId, loadChannels, loadKeypair } from "./storage.js";
import { transcribeAudio, generateReplyAudio } from "./audio.js";
import type { STTProvider } from "../stt/interface.js";
import type { TTSProvider } from "../tts/interface.js";
import { getCopyRuntime } from "../runtime.js";

const inFlight = new Set<string>();
let cachedUserId: string | null = null;

export interface InboundContext {
  core: PluginRuntime;
  runtime: RuntimeEnv;
  copyConfig: CopyConfig;
  accountId?: string;
  apiUrl: string;
  dataDir: string;
  tmpDir: string;
  stt: STTProvider;
  tts: TTSProvider;
}

/**
 * Handle a raw WebSocket event from Copy.
 * Filters out pings, own echoes, and deduplicates in-flight messages.
 */
export async function handleCopyWsEvent(
  msg: CopyWsEvent,
  channelId: string,
  ctx: InboundContext,
): Promise<void> {
  if (msg.type === "ping" || msg.type === "pong") return;

  ctx.runtime.log?.(`[WS event] type="${msg.type}"`);

  if (msg.type !== "new_message") return;

  // Support different WS event shapes
  let message = (msg.message ?? msg.data ?? msg.payload) as CopyMessage | undefined;

  if (!message && (msg as any).messageId) {
    message = {
      id: (msg as any).messageId,
      senderId: (msg as any).senderId,
      nonce: (msg as any).nonce,
    } as CopyMessage;
  }

  if (!message) {
    ctx.runtime.error?.("[Copy] new_message event missing payload");
    return;
  }

  const msgId = message.id;
  if (!msgId) {
    ctx.runtime.error?.("[Copy] Message has no ID");
    return;
  }

  // Filter own echoes
  if (!cachedUserId) {
    cachedUserId = await readUserId(ctx.dataDir);
  }
  if (cachedUserId && message.senderId === cachedUserId) {
    return;
  }

  // Deduplicate in-flight
  if (inFlight.has(msgId)) return;
  inFlight.add(msgId);

  try {
    await processIncomingMessage(message, channelId, ctx);
  } catch (err) {
    ctx.runtime.error?.(`[Copy] Error processing ${msgId.slice(0, 8)}: ${err}`);
  } finally {
    inFlight.delete(msgId);
  }
}

/**
 * Process a single incoming Copy message through the OpenClaw pipeline.
 */
async function processIncomingMessage(
  message: CopyMessage,
  channelId: string,
  ctx: InboundContext,
): Promise<void> {
  const id = message.id;
  const tag = id.slice(0, 8);
  const log = (msg: string) => ctx.runtime.log?.(msg);
  const error = (msg: string) => ctx.runtime.error?.(msg);

  // Look up channel info
  const { channels } = await loadChannels(ctx.dataDir);
  const channel = channels.find((c) => c.channelId === channelId);
  if (!channel) {
    error(`[Copy:${tag}] No channel info for ${channelId}`);
    return;
  }

  // Load keypair
  const keypair = await loadKeypair(ctx.dataDir);
  if (!keypair) {
    error(`[Copy:${tag}] No keypair found`);
    return;
  }

  // Download encrypted audio
  log(`[Copy:${tag}] Downloading audio...`);
  const encryptedBytes = await downloadAudio(ctx.apiUrl, id, channelId);
  if (!encryptedBytes || encryptedBytes.length === 0) {
    error(`[Copy:${tag}] Empty download`);
    return;
  }
  log(`[Copy:${tag}] Downloaded ${encryptedBytes.length} bytes`);

  // Decrypt audio
  let decryptedAudio: Uint8Array;
  if (!message.nonce) {
    error(`[Copy:${tag}] No nonce in message`);
    return;
  }

  try {
    decryptedAudio = await decryptAudioRaw(
      encryptedBytes,
      message.nonce,
      channel.friendPublicKey,
      keypair.privateKey,
    );
    log(`[Copy:${tag}] Decrypted ${decryptedAudio.length} bytes`);
  } catch {
    // Maybe R2 returned base64 text
    try {
      const ciphertextB64 = Buffer.from(encryptedBytes).toString("utf8").trim();
      decryptedAudio = await decryptAudio(
        ciphertextB64,
        message.nonce,
        channel.friendPublicKey,
        keypair.privateKey,
      );
      log(`[Copy:${tag}] Decrypted ${decryptedAudio.length} bytes (b64 body)`);
    } catch (e2) {
      error(`[Copy:${tag}] Decryption failed: ${e2}`);
      return;
    }
  }

  // Transcribe audio to text
  const transcription = await transcribeAudio(
    decryptedAudio,
    ctx.stt,
    ctx.tmpDir,
    tag,
    log,
  );

  // Route through OpenClaw pipeline
  const core = getCopyRuntime();
  const cfg = core.config.loadConfig() as CoreConfig;
  const copyConfig = ctx.copyConfig;

  const senderName = channel.friendDisplayName ?? channel.friendUserId.slice(0, 8);
  const senderId = channel.friendUserId;

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "copy",
    accountId: ctx.accountId,
    peer: { kind: "direct", id: senderId },
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const voiceHint = copyConfig.voicePrompt ?? VOICE_PROMPT;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Copy",
    from: senderName,
    timestamp: undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: transcription,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: transcription,
    RawBody: transcription,
    CommandBody: transcription,
    From: `copy:dm:${senderId}`,
    To: `channel:${channelId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: senderName,
    SenderName: senderName,
    SenderId: senderId,
    SenderUsername: senderName,
    GroupSystemPrompt: voiceHint,
    Provider: "copy" as const,
    Surface: "copy" as const,
    WasMentioned: true,
    MessageSid: id,
    OriginatingChannel: "copy" as const,
    OriginatingTo: `channel:${channelId}`,
    CommandAuthorized: true,
    CommandSource: "text" as const,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      error(`[Copy] session record error: ${String(err)}`);
    },
  });

  log(`[Copy] inbound: channel=${channelId.slice(0, 8)} from=${senderName} text="${transcription.slice(0, 100)}"`);

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "copy",
    accountId: route.accountId,
  });

  const replyTarget = ctxPayload.To;
  if (!replyTarget) {
    error("[Copy] missing reply target");
    return;
  }

  // Create reply dispatcher — deliver callback handles TTS → encrypt → upload
  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        try {
          const text =
            typeof payload === "string" ? payload : (payload as any).text ?? String(payload);

          // Generate TTS audio
          const replyTag = randomUUID().slice(0, 8);
          const audioBytes = await generateReplyAudio(text, ctx.tts, ctx.tmpDir, replyTag, log);

          // Encrypt
          const { ciphertext, nonce } = await encryptAudio(
            new Uint8Array(audioBytes),
            channel.friendPublicKey,
            keypair.privateKey,
          );

          // Upload to Copy
          const uploadRes = await uploadMessage(ctx.apiUrl, channelId, nonce, ciphertext);
          if (uploadRes.ok) {
            log(`[Copy:${tag}] Reply delivered`);
            log(`  Them:  "${transcription.slice(0, 120)}"`);
            log(`  Agent: "${text.slice(0, 120)}"`);
          } else {
            error(`[Copy:${tag}] Upload failed: ${uploadRes.error}`);
          }
        } catch (err) {
          error(`[Copy] reply delivery failed: ${String(err)}`);
        }
      },
      onError: (err, info) => {
        error(`[Copy] ${info.kind} reply failed: ${String(err)}`);
      },
    });

  const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected,
    },
  });
  markDispatchIdle();

  if (queuedFinal) {
    const finalCount = counts.final;
    log(`[Copy] delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${channelId.slice(0, 8)}`);
  }
}
