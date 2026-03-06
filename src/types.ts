import type { DmPolicy } from "openclaw/plugin-sdk";
export type { DmPolicy };

/** Default Copy backend API URL. */
export const DEFAULT_COPY_API_URL = "https://walkie-talkie-api.matt8066.workers.dev";

/** Per-channel (peer) config for Copy */
export type CopyChannelConfig = {
  /** If false, disable the bot for this peer. */
  enabled?: boolean;
  /** Optional system prompt snippet for voice replies. */
  systemPrompt?: string;
};

export type CopyDmConfig = {
  enabled?: boolean;
  policy?: DmPolicy;
  allowFrom?: string[];
  channels?: Record<string, CopyChannelConfig>;
};

export type CopySttConfig = {
  /** STT provider: "whisper-api" (default) */
  provider?: "whisper-api";
  /** Whisper API URL */
  url?: string;
  /** Whisper model size */
  model?: string;
  /** Language code */
  language?: string;
};

export type CopyTtsConfig = {
  /** TTS provider: "chatterbox" (default) */
  provider?: "chatterbox";
  /** TTS server URL */
  url?: string;
  /** Provider-specific params */
  params?: {
    exaggeration?: number;
    cfg_weight?: number;
    temperature?: number;
  };
};

export type CopyConfig = {
  /** Optional display name for this account. */
  name?: string;
  /** If false, do not start Copy. Default: true. */
  enabled?: boolean;
  /** Copy API URL. */
  apiUrl?: string;
  /** Display name in Copy. */
  displayName?: string;
  /** STT configuration. */
  stt?: CopySttConfig;
  /** TTS configuration. */
  tts?: CopyTtsConfig;
  /** DM config (all Copy channels are direct). */
  dm?: CopyDmConfig;
  /** Data directory for keypair, session, channels. */
  dataDir?: string;
  /**
   * Voice format system prompt hint appended to agent context.
   * Tells the agent to respond in voice-friendly format.
   */
  voicePrompt?: string;
};

export type CoreConfig = {
  channels?: {
    copy?: CopyConfig;
    defaults?: {
      groupPolicy?: "open" | "allowlist" | "disabled";
    };
  };
  session?: {
    store?: string;
  };
  [key: string]: unknown;
};

/** Stored keypair (Ed25519 signing + X25519 encryption) */
export type Keypair = {
  signingPublicKey: string;
  signingPrivateKey: string;
  publicKey: string;
  privateKey: string;
};

/** Stored session (JWT) */
export type Session = {
  userId: string;
  token: string;
  expiresAt: number;
};

/** Group channel member */
export type GroupMember = {
  userId: string;
  publicKey: string;
  signingKey?: string;
  displayName?: string;
};

/** Stored channel/peer info (pairwise or group) */
export type ChannelInfo = {
  channelId: string;
  channelType?: "pairwise" | "group";

  // Pairwise fields
  friendUserId?: string;
  friendPublicKey?: string;
  friendDisplayName?: string;

  // Group fields
  members?: GroupMember[];
  channelName?: string;
  keyVersion?: number;

  pairedAt: string;
};

/** Copy API message model */
export type CopyMessage = {
  id: string;
  senderId: string;
  channelId: string;
  nonce: string;
  r2Key?: string;
  createdAt: string;
  encryptionType?: "pairwise" | "group";
  signature?: string;
  seq?: number;
};

/** WebSocket event from Copy */
export type CopyWsEvent = {
  type: string;
  message?: CopyMessage;
  data?: CopyMessage;
  payload?: CopyMessage;
  messageId?: string;
  senderId?: string;
  nonce?: string;
  // Group event fields
  userId?: string;
  displayName?: string;
  channelId?: string;
  publicKey?: string;
  signingKey?: string;
  keyVersion?: number;
  name?: string;
  [key: string]: unknown;
};

/** Discriminated upload params for pairwise vs group messages */
export type UploadMessageParams =
  | { type: "pairwise"; channelId: string; nonce: string; ciphertext: string }
  | { type: "group"; channelId: string; nonce: string; ciphertext: string; signature: string };

/** Default voice format prompt */
export const DEFAULT_VOICE_PROMPT =
  "This conversation is via voice (Copy walkie-talkie). " +
  "Respond naturally as if speaking aloud. No bullet points, no markdown, no formatting. " +
  "Keep responses concise — 2-4 sentences unless asked for more.";
