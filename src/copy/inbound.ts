/**
 * Inbound message processing for Copy.
 *
 * Pipeline: WS event → download → decrypt → STT → SDK dispatch → deliver callback (TTS → encrypt → upload)
 *
 * Uses the SDK's dispatch pipeline (resolveAgentRoute → finalizeInboundContext →
 * dispatchReplyFromConfig) exactly like Discord and Campfire. The `deliver` callback
 * handles TTS → encrypt → upload.
 */

import {
  createReplyPrefixOptions,
  type PluginRuntime,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { CopyConfig, CopyMessage, CopyWsEvent, CoreConfig } from "../types.js";
import { DEFAULT_VOICE_PROMPT as VOICE_PROMPT } from "../types.js";
import { downloadAudio } from "./api.js";
import { decryptAudioRaw, decryptAudio } from "./crypto.js";
import { readUserId, loadChannels, loadKeypair } from "./storage.js";
import { transcribeAudio } from "./audio.js";
import { deliverVoiceReply } from "./deliver.js";
import type { STTProvider } from "../stt/interface.js";
import type { TTSProvider } from "../tts/interface.js";

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
 * Process a single incoming Copy message through the SDK dispatch pipeline.
 *
 * 1. Download + decrypt audio
 * 2. Transcribe via Whisper
 * 3. Route through SDK dispatch (resolveAgentRoute → finalizeInboundContext → dispatchReplyFromConfig)
 * 4. deliver callback: TTS → encrypt → upload
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

  // ── Step 1: Download encrypted audio ──
  log(`[Copy:${tag}] Downloading audio...`);
  const encryptedBytes = await downloadAudio(ctx.apiUrl, id, channelId);
  if (!encryptedBytes || encryptedBytes.length === 0) {
    error(`[Copy:${tag}] Empty download`);
    return;
  }
  log(`[Copy:${tag}] Downloaded ${encryptedBytes.length} bytes`);

  // ── Step 2: Decrypt ──
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

  // ── Step 3: Transcribe ──
  const transcription = await transcribeAudio(
    decryptedAudio,
    ctx.stt,
    ctx.tmpDir,
    tag,
    log,
  );

  if (!transcription?.trim()) {
    log(`[Copy:${tag}] Empty transcription, skipping`);
    return;
  }

  log(`[Copy] inbound: channel=${channelId.slice(0, 8)} from=${channel.friendDisplayName ?? "?"} text="${transcription.slice(0, 100)}"`);

  // ── Step 4: SDK dispatch pipeline ──
  const cfg = ctx.core.config.loadConfig() as CoreConfig;
  const friendUserId = channel.friendUserId;

  // Resolve agent route
  const route = ctx.core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "copy",
    accountId: ctx.accountId,
    peer: { kind: "direct", id: friendUserId },
  });

  // Build envelope
  const envelopeFrom = channel.friendDisplayName ?? friendUserId;
  const envelopeOptions = ctx.core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const storePath = ctx.core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const previousTimestamp = ctx.core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = ctx.core.channel.reply.formatAgentEnvelope({
    channel: "Copy",
    from: envelopeFrom,
    timestamp: undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: transcription,
  });

  // Voice prompt: base + optional per-channel system prompt
  const voiceHint = ctx.copyConfig.voicePrompt ?? VOICE_PROMPT;
  const channelSystemPrompt = ctx.copyConfig.dm?.channels?.[channelId]?.systemPrompt?.trim();
  const groupSystemPrompt = channelSystemPrompt
    ? `${voiceHint}\n\n${channelSystemPrompt}`
    : voiceHint;

  // Build finalized context
  const ctxPayload = ctx.core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: transcription,
    RawBody: transcription,
    CommandBody: transcription,
    From: `copy:dm:${friendUserId}`,
    To: `dm:${friendUserId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: envelopeFrom,
    SenderName: envelopeFrom,
    SenderId: friendUserId,
    SenderUsername: envelopeFrom,
    GroupSystemPrompt: groupSystemPrompt,
    Provider: "copy" as const,
    Surface: "copy" as const,
    WasMentioned: true,
    MessageSid: id,
    OriginatingChannel: "copy" as const,
    OriginatingTo: `dm:${friendUserId}`,
    CommandAuthorized: true,
    CommandSource: "text" as const,
  });

  // Record session
  await ctx.core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      error(`[Copy] failed updating session meta: ${String(err)}`);
    },
  });

  // Reply prefix options
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "copy",
    accountId: route.accountId,
  });

  // Create dispatcher with deliver callback
  const { dispatcher, replyOptions, markDispatchIdle } =
    ctx.core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: ctx.core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        const text = typeof payload === "string" ? payload : (payload as any).text ?? String(payload);
        const result = await deliverVoiceReply({
          text,
          channelId,
          friendPublicKey: channel.friendPublicKey,
          privateKey: keypair.privateKey,
          apiUrl: ctx.apiUrl,
          tmpDir: ctx.tmpDir,
          tts: ctx.tts,
          log,
          error,
        });
        if (result.ok) {
          log(`  Them:  "${transcription.slice(0, 120)}"`);
          log(`  Agent: "${text.slice(0, 120)}"`);
        }
      },
      onError: (err, info) => {
        error(`[Copy] ${info.kind} reply failed: ${String(err)}`);
      },
    });

  // Dispatch
  const { queuedFinal, counts } = await ctx.core.channel.reply.dispatchReplyFromConfig({
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
    log(`[Copy] delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to dm:${friendUserId}`);
  }
}
