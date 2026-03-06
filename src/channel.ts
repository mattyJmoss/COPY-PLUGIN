/**
 * Copy channel plugin — registers Copy as an OpenClaw channel.
 *
 * Supports both pairwise (1:1) and group voice channels:
 * - Pairwise: crypto_box E2E encryption
 * - Group: crypto_secretbox symmetric + Ed25519 signatures
 * - Group response decision: [SKIP] detection suppresses delivery
 * - Key rotation: on member_left, generate new secret + seal for remaining members
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import { CopyConfigSchema } from "./config-schema.js";
import { copyOutbound } from "./outbound.js";
import sodium from "libsodium-wrappers";
import { DEFAULT_COPY_API_URL, type CopyConfig, type CopyWsEvent, type CoreConfig, type ChannelInfo, type GroupMember, type Keypair } from "./types.js";
import { getCopyRuntime } from "./runtime.js";
import { loadOrAuthenticate, ensureValidToken } from "./copy/auth.js";
import { loadKeypair, loadChannels, loadChannelSecret, saveChannelSecret, addChannel } from "./copy/storage.js";
import { ChannelSocket } from "./copy/websocket.js";
import { handleCopyWsEvent, type InboundContext } from "./copy/inbound.js";
import { sealChannelSecret, openSealedSecret, ensureSodium } from "./copy/crypto.js";
import { fetchSealedKey, uploadSealedKey } from "./copy/api.js";
import { detectLinkType, joinGroupFromInvite, joinPairwiseFromLink } from "./copy/join.js";
import { WhisperSTT } from "./stt/whisper.js";
import { ChatterboxTTS } from "./tts/chatterbox.js";
import type { STTProvider } from "./stt/interface.js";
import type { TTSProvider } from "./tts/interface.js";

const DEFAULT_WHISPER_URL = "http://localhost:9000";
const DEFAULT_CHATTERBOX_URL = "http://localhost:4123";

const meta = {
  id: "copy",
  label: "Copy",
  selectionLabel: "Copy (voice plugin)",
  docsPath: "/channels/copy",
  docsLabel: "copy",
  blurb: "async voice messaging via Copy walkie-talkie app; audio encrypted end-to-end with libsodium.",
  order: 90,
  quickstartAllowFrom: false,
};

/** Resolve the data directory for Copy state files. */
export function resolveDataDir(configured?: string): string {
  return configured ?? join(homedir(), ".openclaw", "extensions", "copy", "data");
}

/** Resolve the tmp directory for audio processing. */
export function resolveTmpDir(dataDir: string): string {
  return join(dataDir, "tmp");
}

/** Resolve the Copy API URL. */
export function resolveApiUrl(configured?: string): string {
  return configured ?? DEFAULT_COPY_API_URL;
}

/** Create an STT provider from config. */
export function createSTTProvider(copyConfig: CopyConfig): STTProvider {
  const url = copyConfig.stt?.url ?? DEFAULT_WHISPER_URL;
  return new WhisperSTT({
    url,
    model: copyConfig.stt?.model,
    language: copyConfig.stt?.language,
  });
}

/** Create a TTS provider from config. */
export function createTTSProvider(copyConfig: CopyConfig): TTSProvider {
  const url = copyConfig.tts?.url ?? DEFAULT_CHATTERBOX_URL;
  return new ChatterboxTTS({
    url,
    params: copyConfig.tts?.params,
  });
}

function resolveCopyConfig(cfg: CoreConfig): CopyConfig {
  return cfg.channels?.copy ?? {};
}

type ResolvedCopyAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  config: CopyConfig;
  apiUrl?: string;
};

function resolveCopyAccount(params: {
  cfg: CoreConfig;
  accountId?: string;
}): ResolvedCopyAccount {
  const config = resolveCopyConfig(params.cfg);
  const dataDir = resolveDataDir(config.dataDir);

  return {
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    name: config.name ?? config.displayName,
    enabled: config.enabled !== false,
    configured: Boolean(config.apiUrl),
    config,
    apiUrl: config.apiUrl,
  };
}

export const copyPlugin: ChannelPlugin<ResolvedCopyAccount> = {
  id: "copy",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    polls: false,
    reactions: false,
    threads: false,
    media: false,
  },
  reload: { configPrefixes: ["channels.copy"] },
  configSchema: buildChannelConfigSchema(CopyConfigSchema as any),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) =>
      resolveCopyAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.apiUrl,
    }),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "open",
      allowFrom: account.config.dm?.allowFrom ?? [],
      policyPath: "channels.copy.dm.policy",
      allowFromPath: "channels.copy.dm.allowFrom",
      approveHint: "Set channels.copy.dm.policy to 'open' to allow all paired friends",
    }),
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      const stripped = trimmed.replace(/^(copy:|channel:)/i, "").trim();
      return stripped || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => /^[a-f0-9-]{8,}$/i.test(raw.trim()),
      hint: "<channel-id>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg }) => {
      const config = resolveCopyConfig(cfg as CoreConfig);
      const dataDir = resolveDataDir(config.dataDir);
      const { channels } = await loadChannels(dataDir);
      return channels
        .filter((ch) => (ch.channelType ?? "pairwise") === "pairwise")
        .map((ch) => ({
          kind: "user" as const,
          id: ch.friendUserId ?? ch.channelId,
          name: ch.friendDisplayName,
        }));
    },
    listGroups: async ({ cfg }) => {
      const config = resolveCopyConfig(cfg as CoreConfig);
      const dataDir = resolveDataDir(config.dataDir);
      const { channels } = await loadChannels(dataDir);
      return channels
        .filter((ch) => ch.channelType === "group")
        .map((ch) => ({
          kind: "group" as const,
          id: ch.channelId,
          name: ch.channelName ?? `Group (${ch.members?.length ?? 0})`,
        }));
    },
  },
  outbound: copyOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "copy",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.apiUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const copyConfig = account.config;
      const apiUrl = resolveApiUrl(copyConfig.apiUrl);
      const dataDir = resolveDataDir(copyConfig.dataDir);
      const tmpDir = resolveTmpDir(dataDir);

      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.apiUrl,
      });

      ctx.log?.info(`[Copy] Starting provider (${apiUrl})`);

      if (!copyConfig.apiUrl) {
        ctx.log?.warn("[Copy] apiUrl not configured");
        return;
      }

      // Load keypair
      const keypair = await loadKeypair(dataDir);
      if (!keypair) {
        ctx.log?.error("[Copy] No keypair found — run `openclaw copy register` first");
        return;
      }

      ctx.log?.info(`[Copy] Signing key: ${keypair.signingPublicKey.slice(0, 12)}...`);

      // Authenticate
      const logFn = (msg: string) => ctx.log?.info(msg);
      const errorFn = (msg: string) => ctx.log?.error(msg);
      const session = await loadOrAuthenticate(
        apiUrl,
        dataDir,
        keypair.signingPublicKey,
        keypair.signingPrivateKey,
        logFn,
      );

      ctx.log?.info(`[Copy] Authenticated as ${session.userId}`);

      // Load paired channels
      const { channels } = await loadChannels(dataDir);
      if (channels.length === 0) {
        ctx.log?.warn("[Copy] No channels paired — run `openclaw copy pair <link>` to pair");
        return;
      }

      // Group state (closure variables)
      const channelSecrets = new Map<string, Uint8Array>();
      const cachedChannels = [...channels];
      const rotationLocks = new Map<string, Promise<void>>();

      // Load channel secrets for group channels + verify/recover
      for (const channel of channels) {
        if ((channel.channelType ?? "pairwise") === "group") {
          let secret = await loadChannelSecret(dataDir, channel.channelId);
          if (!secret) {
            ctx.log?.warn(`[Copy] No channel secret for group ${channel.channelId}, fetching from server`);
            try {
              const sealed = await fetchSealedKey(apiUrl, channel.channelId);
              if (sealed.ok && sealed.data?.sealedKey) {
                secret = await openSealedSecret(
                  sealed.data.sealedKey,
                  keypair.publicKey,
                  keypair.privateKey,
                );
                await saveChannelSecret(dataDir, channel.channelId, secret);
                ctx.log?.info(`[Copy] Channel secret recovered for ${channel.channelId}`);
              } else {
                ctx.log?.error(`[Copy] Cannot recover secret for ${channel.channelId}, skipping`);
                continue;
              }
            } catch (err) {
              ctx.log?.error(`[Copy] Failed to recover secret for ${channel.channelId}: ${err}`);
              continue;
            }
          }
          channelSecrets.set(channel.channelId, secret);
        }
      }

      // Fix self-member userId (set to "" during join, needs actual userId)
      for (const channel of cachedChannels) {
        if (channel.channelType === "group" && channel.members) {
          const selfMember = channel.members.find((m) => m.userId === "");
          if (selfMember) {
            selfMember.userId = session.userId;
          }
        }
      }

      const groupCount = channels.filter((c) => (c.channelType ?? "pairwise") === "group").length;
      const pairwiseCount = channels.length - groupCount;
      ctx.log?.info(`[Copy] ${pairwiseCount} pairwise + ${groupCount} group channel(s)`);

      // Create STT/TTS providers
      const stt = createSTTProvider(copyConfig);
      const tts = createTTSProvider(copyConfig);
      ctx.log?.info(`[Copy] STT: ${stt.name}, TTS: ${tts.name}`);

      // ── Group WS Event Handlers ──

      function handleMemberAdded(channelId: string, event: CopyWsEvent): void {
        const channel = cachedChannels.find((c) => c.channelId === channelId);
        if (!channel?.members) return;

        const newMember: GroupMember = {
          userId: event.userId ?? "",
          publicKey: event.publicKey ?? "",
          signingKey: event.signingKey,
          displayName: event.displayName,
        };

        if (!channel.members.some((m) => m.userId === newMember.userId)) {
          channel.members.push(newMember);
          ctx.log?.info(`[Copy] Member ${newMember.displayName ?? newMember.userId} added to ${channelId}`);
        }
      }

      async function handleMemberLeft(channelId: string, event: CopyWsEvent): Promise<void> {
        // Serialize rotation per channel
        const existing = rotationLocks.get(channelId);
        if (existing) await existing;

        const rotation = (async () => {
          const channel = cachedChannels.find((c) => c.channelId === channelId);
          if (!channel?.members) return;

          const leftUserId = event.userId;
          if (!leftUserId) return;

          channel.members = channel.members.filter((m) => m.userId !== leftUserId);
          ctx.log?.info(`[Copy] Member ${leftUserId} left ${channelId}, ${channel.members.length} remaining`);

          if (channel.members.length <= 1) {
            ctx.log?.info(`[Copy] Group ${channelId} has <=1 member, skipping key rotation`);
            return;
          }

          // Generate new channel secret
          await ensureSodium();
          const newSecret = sodium.randombytes_buf(32);

          // Seal for each remaining member
          for (const member of channel.members) {
            if (member.userId === session.userId) continue;
            try {
              const sealed = await sealChannelSecret(newSecret, member.publicKey);
              await uploadSealedKey(apiUrl, channelId, member.userId, sealed);
            } catch (err) {
              ctx.log?.warn(`[Copy] Failed to seal key for ${member.userId}: ${err}`);
            }
          }

          // Save new secret locally
          await saveChannelSecret(dataDir, channelId, newSecret);
          channelSecrets.set(channelId, newSecret);

          channel.keyVersion = (channel.keyVersion ?? 0) + 1;
          ctx.log?.info(`[Copy] Key rotated for ${channelId}, version ${channel.keyVersion}`);
        })();

        rotationLocks.set(channelId, rotation);
        await rotation;
        rotationLocks.delete(channelId);
      }

      async function handleKeyUpdate(channelId: string): Promise<void> {
        try {
          const sealed = await fetchSealedKey(apiUrl, channelId);
          if (sealed.ok && sealed.data?.sealedKey) {
            const newSecret = await openSealedSecret(
              sealed.data.sealedKey,
              keypair.publicKey,
              keypair.privateKey,
            );
            await saveChannelSecret(dataDir, channelId, newSecret);
            channelSecrets.set(channelId, newSecret);
            ctx.log?.info(`[Copy] Channel secret updated for ${channelId}`);
          } else {
            ctx.log?.error(`[Copy] Failed to fetch sealed key for ${channelId}: ${sealed.error}`);
          }
        } catch (err) {
          ctx.log?.error(`[Copy] Error handling key_update for ${channelId}: ${err}`);
        }
      }

      // ── WS Event Dispatch ──

      function dispatchWsEvent(wsEvent: CopyWsEvent, channelId: string): void {
        const channel = cachedChannels.find((c) => c.channelId === channelId);
        const isGroup = (channel?.channelType ?? "pairwise") === "group";

        if (wsEvent.type === "new_message") {
          handleCopyWsEvent(wsEvent, channelId, inboundCtx).catch((err) => {
            ctx.log?.error(`[Copy] Error dispatching WS event: ${err}`);
          });
        } else if (isGroup) {
          switch (wsEvent.type) {
            case "member_added":
              handleMemberAdded(channelId, wsEvent);
              break;
            case "member_left":
              handleMemberLeft(channelId, wsEvent).catch((err) => {
                ctx.log?.error(`[Copy] Error handling member_left: ${err}`);
              });
              break;
            case "key_update":
              handleKeyUpdate(channelId).catch((err) => {
                ctx.log?.error(`[Copy] Error handling key_update: ${err}`);
              });
              break;
            case "message_deleted":
              ctx.log?.info(`[Copy] Message deleted in ${channelId}`);
              break;
          }
        }
      }

      // Build inbound context (with group state)
      const inboundCtx: InboundContext = {
        core: getCopyRuntime(),
        runtime: ctx.runtime,
        copyConfig,
        accountId: account.accountId,
        apiUrl,
        dataDir,
        tmpDir,
        stt,
        tts,
        channels: cachedChannels,
        keypair,
        channelSecrets,
      };

      // Start WebSocket listeners for each channel
      const sockets: ChannelSocket[] = [];
      const tokenRefresher = () =>
        ensureValidToken(
          apiUrl,
          dataDir,
          keypair.signingPublicKey,
          keypair.signingPrivateKey,
          logFn,
        ).then(() => {});

      for (const channel of channels) {
        // Skip group channels we couldn't get a secret for
        if ((channel.channelType ?? "pairwise") === "group" && !channelSecrets.has(channel.channelId)) {
          ctx.log?.warn(`[Copy] Skipping group channel ${channel.channelId} — no secret available`);
          continue;
        }

        const name = channel.channelType === "group"
          ? (channel.channelName ?? `Group (${channel.members?.length ?? 0})`)
          : (channel.friendDisplayName ?? channel.friendUserId?.slice(0, 8) ?? "?");
        ctx.log?.info(`[Copy] Starting listener for ${name} (${channel.channelId.slice(0, 8)}...)`);

        const socket = new ChannelSocket(
          apiUrl,
          channel.channelId,
          (msg) => dispatchWsEvent(msg as CopyWsEvent, channel.channelId),
          tokenRefresher,
          logFn,
        );
        sockets.push(socket);
        await socket.start();
      }

      ctx.log?.info(`[Copy] Live — listening on ${pairwiseCount} pairwise + ${groupCount} group channel(s)`);

      // Clean up on abort
      ctx.abortSignal.addEventListener("abort", () => {
        ctx.log?.info("[Copy] Shutting down...");
        for (const socket of sockets) {
          socket.stop();
        }
        channelSecrets.clear();
        ctx.log?.info("[Copy] All sockets closed");
      });

      // Keep running until aborted
      return new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => resolve());
      });
    },
  },
};
