/**
 * Copy channel plugin — registers Copy as an OpenClaw channel.
 *
 * All Copy channels are direct (1:1 voice) — no group messaging.
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
import type { CopyConfig, CoreConfig } from "./types.js";
import { getCopyRuntime } from "./runtime.js";
import { loadOrAuthenticate, ensureValidToken } from "./copy/auth.js";
import { loadKeypair, loadChannels } from "./copy/storage.js";
import { ChannelSocket } from "./copy/websocket.js";
import { handleCopyWsEvent, type InboundContext } from "./copy/inbound.js";
import { WhisperSTT } from "./stt/whisper.js";
import { ChatterboxTTS } from "./tts/chatterbox.js";
import type { STTProvider } from "./stt/interface.js";
import type { TTSProvider } from "./tts/interface.js";

const DEFAULT_API_URL = "https://walkie-talkie-api.matt8066.workers.dev";
const DEFAULT_WHISPER_URL = "http://bazzite.local:9000";
const DEFAULT_CHATTERBOX_URL = "http://bazzite.local:4123";

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
  return configured ?? DEFAULT_API_URL;
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
    chatTypes: ["direct"],
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
      return channels.map((ch) => ({
        kind: "user" as const,
        id: ch.friendUserId,
        name: ch.friendDisplayName,
      }));
    },
    listGroups: async () => [],
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

      ctx.log?.info(`[Copy] ${channels.length} paired channel(s)`);

      // Create STT/TTS providers
      const stt = createSTTProvider(copyConfig);
      const tts = createTTSProvider(copyConfig);
      ctx.log?.info(`[Copy] STT: ${stt.name}, TTS: ${tts.name}`);

      // Build inbound context
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
        const name = channel.friendDisplayName ?? channel.friendUserId.slice(0, 8);
        ctx.log?.info(`[Copy] Starting listener for ${name} (${channel.channelId.slice(0, 8)}...)`);

        const socket = new ChannelSocket(
          apiUrl,
          channel.channelId,
          (msg) => handleCopyWsEvent(msg, channel.channelId, inboundCtx),
          tokenRefresher,
          logFn,
        );
        sockets.push(socket);
        await socket.start();
      }

      ctx.log?.info(`[Copy] Live — listening on ${channels.length} channel(s)`);

      // Clean up on abort
      ctx.abortSignal.addEventListener("abort", () => {
        ctx.log?.info("[Copy] Shutting down...");
        for (const socket of sockets) {
          socket.stop();
        }
        ctx.log?.info("[Copy] All sockets closed");
      });

      // Keep running until aborted
      return new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => resolve());
      });
    },
  },
};
