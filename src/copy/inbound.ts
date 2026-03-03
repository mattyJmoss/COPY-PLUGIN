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
import type { CopyConfig, CopyMessage, CopyWsEvent, CoreConfig, ChannelInfo, Keypair } from "../types.js";
import { DEFAULT_VOICE_PROMPT as VOICE_PROMPT } from "../types.js";
import { downloadAudio, ackMessage } from "./api.js";
import { decryptAudioRaw, decryptAudio, deriveGroupKey, decryptGroupAudio, decryptGroupAudioRaw } from "./crypto.js";
import { readUserId, loadChannels, loadKeypair } from "./storage.js";
import { transcribeAudio } from "./audio.js";
import { deliverVoiceReply, deliverGroupVoiceReply } from "./deliver.js";
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
  /** Cached channels list (includes group channels) */
  channels?: ChannelInfo[];
  /** Cached keypair for crypto operations */
  keypair?: Keypair;
  /** Channel secrets for group channels (channelId -> secret) */
  channelSecrets?: Map<string, Uint8Array>;
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
      signature: (msg as any).signature,
      encryptionType: (msg as any).encryptionType,
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
    const processed = await processIncomingMessage(message, channelId, ctx);

    // Fire-and-forget ack after successful processing
    if (processed) {
      ackMessage(ctx.apiUrl, msgId, channelId).catch((err) => {
        ctx.runtime.error?.(`[Copy:${msgId.slice(0, 8)}] Ack failed: ${err}`);
      });
    }
  } catch (err) {
    ctx.runtime.error?.(`[Copy] Error processing ${msgId.slice(0, 8)}: ${err}`);
  } finally {
    inFlight.delete(msgId);
  }
}

/**
 * Process a single incoming Copy message through the SDK dispatch pipeline.
 *
 * 1. Download + decrypt audio (pairwise or group)
 * 2. Transcribe via Whisper
 * 3. Route through SDK dispatch (resolveAgentRoute -> finalizeInboundContext -> dispatchReplyFromConfig)
 * 4. deliver callback: TTS -> encrypt -> upload
 *
 * Returns true if message was processed successfully (for ack).
 */
async function processIncomingMessage(
  message: CopyMessage,
  channelId: string,
  ctx: InboundContext,
): Promise<boolean> {
  const id = message.id;
  const tag = id.slice(0, 8);
  const log = (msg: string) => ctx.runtime.log?.(msg);
  const error = (msg: string) => ctx.runtime.error?.(msg);

  // Look up channel info — prefer cached channels if available
  let channels: ChannelInfo[];
  if (ctx.channels) {
    channels = ctx.channels;
  } else {
    const loaded = await loadChannels(ctx.dataDir);
    channels = loaded.channels;
  }
  const channel = channels.find((c) => c.channelId === channelId);
  if (!channel) {
    error(`[Copy:${tag}] No channel info for ${channelId}`);
    return false;
  }

  // Load keypair — prefer cached
  let keypair: Keypair;
  if (ctx.keypair) {
    keypair = ctx.keypair;
  } else {
    const loaded = await loadKeypair(ctx.dataDir);
    if (!loaded) {
      error(`[Copy:${tag}] No keypair found`);
      return false;
    }
    keypair = loaded;
  }

  const encType = (channel.channelType ?? "pairwise") === "group" ? "group" : "pairwise";

  // ── Step 1: Download encrypted audio ──
  log(`[Copy:${tag}] Downloading audio...`);
  const encryptedBytes = await downloadAudio(ctx.apiUrl, id, channelId);
  if (!encryptedBytes || encryptedBytes.length === 0) {
    error(`[Copy:${tag}] Empty download`);
    return false;
  }
  log(`[Copy:${tag}] Downloaded ${encryptedBytes.length} bytes`);

  // ── Step 2: Decrypt ──
  if (!message.nonce) {
    error(`[Copy:${tag}] No nonce in message`);
    return false;
  }

  let decryptedAudio: Uint8Array;

  if (encType === "group") {
    // ── Group path: secretbox + signature verification ──
    if (!message.signature) {
      error(`[Copy:${tag}] Group message missing signature`);
      return false;
    }

    const channelSecret = ctx.channelSecrets?.get(channelId);
    if (!channelSecret) {
      error(`[Copy:${tag}] No channel secret for group ${channelId}`);
      return false;
    }

    // Look up sender's signing key
    const senderMember = channel.members?.find((m) => m.userId === message.senderId);
    if (!senderMember?.signingKey) {
      error(`[Copy:${tag}] No signing key for sender ${message.senderId}`);
      return false;
    }

    try {
      const groupKey = await deriveGroupKey(channelSecret);
      // Try raw binary first (server may return raw ciphertext)
      try {
        decryptedAudio = await decryptGroupAudioRaw(
          encryptedBytes,
          message.nonce,
          groupKey,
          message.signature,
          senderMember.signingKey,
        );
        log(`[Copy:${tag}] Group-decrypted ${decryptedAudio.length} bytes (raw)`);
      } catch {
        // Fallback: try interpreting download as base64 string
        const ciphertextB64 = Buffer.from(encryptedBytes).toString("utf8").trim();
        decryptedAudio = await decryptGroupAudio(
          ciphertextB64,
          message.nonce,
          groupKey,
          message.signature,
          senderMember.signingKey,
        );
        log(`[Copy:${tag}] Group-decrypted ${decryptedAudio.length} bytes (b64)`);
      }
    } catch (err) {
      error(`[Copy:${tag}] Group decryption failed: ${err}`);
      return false;
    }
  } else {
    // ── Pairwise path: crypto_box ──
    if (!channel.friendPublicKey) {
      error(`[Copy:${tag}] No friend public key for pairwise channel`);
      return false;
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
        return false;
      }
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
    return false;
  }

  // ── Step 4: SDK dispatch pipeline ──
  const cfg = ctx.core.config.loadConfig() as CoreConfig;
  const isGroup = encType === "group";

  // Determine sender info based on channel type
  let senderId: string;
  let senderName: string;
  if (isGroup) {
    const senderMember = channel.members?.find((m) => m.userId === message.senderId);
    senderId = message.senderId;
    senderName = senderMember?.displayName ?? message.senderId.slice(0, 8);
    log(`[Copy] inbound: group=${channelId.slice(0, 8)} from=${senderName} text="${transcription.slice(0, 100)}"`);
  } else {
    senderId = channel.friendUserId ?? message.senderId;
    senderName = channel.friendDisplayName ?? senderId.slice(0, 8);
    log(`[Copy] inbound: channel=${channelId.slice(0, 8)} from=${senderName} text="${transcription.slice(0, 100)}"`);
  }

  // Resolve agent route
  const route = ctx.core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "copy",
    accountId: ctx.accountId,
    peer: isGroup
      ? { kind: "group", id: channelId }
      : { kind: "direct", id: senderId },
  });

  // Build envelope
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
    from: senderName,
    timestamp: undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: transcription,
  });

  // Voice prompt: base + optional per-channel system prompt + group context
  const voiceHint = ctx.copyConfig.voicePrompt ?? VOICE_PROMPT;
  const channelSystemPrompt = ctx.copyConfig.dm?.channels?.[channelId]?.systemPrompt?.trim();
  let groupSystemPrompt = channelSystemPrompt
    ? `${voiceHint}\n\n${channelSystemPrompt}`
    : voiceHint;

  if (isGroup) {
    const memberCount = channel.members?.length ?? 0;
    groupSystemPrompt += `\n\nGROUP CONVERSATION (${memberCount} members, channel: ${channel.channelName ?? channelId.slice(0, 8)}):\n` +
      "You are in a group voice channel. Not every message needs a response.\n" +
      "Before responding, ask yourself:\n" +
      "- Do I have genuine insight to add?\n" +
      "- Would a friend jump in here?\n" +
      "- Is someone specifically asking me something?\n" +
      'If no to all, respond with exactly "[SKIP]" (nothing else) to stay silent.';
  }

  // Build finalized context
  const chatType = isGroup ? "group" : "direct";
  const fromField = isGroup ? `copy:group:${channelId}` : `copy:dm:${senderId}`;
  const toField = isGroup ? `group:${channelId}` : `dm:${senderId}`;

  const ctxPayload = ctx.core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: transcription,
    RawBody: transcription,
    CommandBody: transcription,
    From: fromField,
    To: toField,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType as any,
    ConversationLabel: isGroup ? (channel.channelName ?? `Group (${channel.members?.length ?? 0})`) : senderName,
    SenderName: senderName,
    SenderId: senderId,
    SenderUsername: senderName,
    GroupSystemPrompt: groupSystemPrompt,
    Provider: "copy" as const,
    Surface: "copy" as const,
    WasMentioned: !isGroup, // Pairwise = always mentioned, group = contextual
    MessageSid: id,
    OriginatingChannel: "copy" as const,
    OriginatingTo: toField,
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

        // [SKIP] detection — agent chose silence for this group message
        if (text.trim() === "[SKIP]") {
          log(`[Copy] Skipping response for ${channelId.slice(0, 8)} — agent chose silence`);
          return;
        }

        let result;
        if (isGroup) {
          const channelSecret = ctx.channelSecrets?.get(channelId);
          if (!channelSecret) {
            error(`[Copy] No channel secret for group delivery to ${channelId}`);
            return;
          }
          result = await deliverGroupVoiceReply({
            text,
            channelId,
            channelSecret,
            signingPrivateKey: keypair.signingPrivateKey,
            apiUrl: ctx.apiUrl,
            tmpDir: ctx.tmpDir,
            tts: ctx.tts,
            log,
            error,
          });
        } else {
          result = await deliverVoiceReply({
            text,
            channelId,
            friendPublicKey: channel.friendPublicKey!,
            privateKey: keypair.privateKey,
            apiUrl: ctx.apiUrl,
            tmpDir: ctx.tmpDir,
            tts: ctx.tts,
            log,
            error,
          });
        }

        if (result?.ok) {
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
    const target = isGroup ? `group:${channelId.slice(0, 8)}` : `dm:${senderId}`;
    log(`[Copy] delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${target}`);
  }

  return true;
}
