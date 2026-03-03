# @openclaw/channel-copy

OpenClaw channel plugin for **Copy** — the async voice messaging (walkie-talkie) app. Makes any OpenClaw agent a Copy friend that can receive and respond to voice messages in both 1:1 and group channels.

## How It Works

### Pairwise (1:1) Channels

```
Copy app (friend speaks)
  → WebSocket new_message event
  → Download encrypted audio from R2
  → Decrypt (X25519 crypto_box)
  → ffmpeg → 16kHz mono WAV
  → Whisper STT (transcribe to text)
  → OpenClaw agent pipeline (full personality, memory, tools)
  → Chatterbox TTS (text → speech)
  → ffmpeg → M4A (64kbps AAC)
  → Encrypt (crypto_box_easy)
  → Upload reply to Copy
```

### Group Channels

```
Copy app (someone speaks in group)
  → WebSocket new_message event
  → Download encrypted audio from R2
  → Derive group key (BLAKE2b KDF from channel secret)
  → Decrypt (crypto_secretbox) + verify Ed25519 signature
  → ffmpeg → 16kHz mono WAV
  → Whisper STT (transcribe to text)
  → OpenClaw agent pipeline (with group conversation context)
  → Agent decides: respond or [SKIP]
  → If responding: TTS → ffmpeg → encrypt (crypto_secretbox) + sign → upload
  → If [SKIP]: stay silent (natural group behavior)
```

All audio is end-to-end encrypted using libsodium. The agent's personality, memory, and tools come from OpenClaw automatically.

## Features

- **Pairwise (1:1) channels** — `crypto_box` (X25519 Diffie-Hellman) E2E encryption
- **Group channels** — `crypto_secretbox` (symmetric) + Ed25519 signatures
- **Key distribution** — `crypto_box_seal` to securely share group keys with each member
- **Key rotation** — automatic on member leave (new secret generated, sealed for remaining members)
- **Group response decisions** — agent decides contextually whether to speak or stay silent
- **Invite-link joining** — join groups via `https://getcopy.app/join/{token}/{secret}` links
- **Message acknowledgment** — `POST /message/:id/ack` after processing (both 1:1 and group)
- **Secret recovery** — if a channel secret is missing on startup, fetches sealed key from server

## Prerequisites

- **ffmpeg** installed and on PATH (audio format conversion)
- **Speech-to-Text server** — any OpenAI-compatible `/v1/audio/transcriptions` endpoint:
  - [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) (self-hosted, free)
  - [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text) (cloud, pay-per-use)
- **Text-to-Speech server** — plugin ships with Chatterbox support, but the `TTSProvider` interface supports any TTS:
  - [Chatterbox](https://github.com/resemble-ai/chatterbox) (self-hosted, free)
  - [ElevenLabs](https://elevenlabs.io) (cloud, high-quality)
  - [Cartesia](https://cartesia.ai) (cloud, low-latency)
- **Copy account** — registered on a Copy backend

## Setup

### 1. Install the plugin

```bash
cd /path/to/this/plugin
npm install
npm run build
```

Then register it with your OpenClaw instance (add the local path to your OpenClaw plugins config).

### 2. Register with Copy

Generate a keypair and register your bot identity with the Copy backend:

```bash
# Set your Copy API URL (or use the default)
export COPY_API_URL="https://walkie-talkie-api.matt8066.workers.dev"

# Optional: set a display name
export COPY_DISPLAY_NAME="Murray"

npm run register
```

This creates `~/.openclaw/extensions/copy/data/keypair.json` (chmod 600).

### 3. Pair with a friend (1:1)

Have your friend generate a Copy pair link, then:

```bash
npm run pair <pair-link-or-token>
```

Accepts:
- Full URL: `walkietalkie://pair/abc123def456...`
- Path format: `/pair/abc123def456...`
- Just the token: `abc123def456...` (32 hex chars)

### 4. Join a group

Have someone in the group generate an invite link, then:

```bash
npm run join <invite-url>
```

Accepts:
- `https://getcopy.app/join/{token}/{base64url_channelSecret}`

The plugin will join the group, save the channel secret locally, and seal the key for each existing member.

### 5. Configure OpenClaw

Add to your OpenClaw config (`~/.openclaw/config.yaml`):

```yaml
channels:
  copy:
    enabled: true
    apiUrl: "https://walkie-talkie-api.matt8066.workers.dev"
    displayName: "Murray"

    stt:
      provider: "whisper-api"
      url: "http://localhost:9000"
      model: "base"
      language: "en"

    tts:
      provider: "chatterbox"
      url: "http://localhost:4123"
      params:
        exaggeration: 0.5
        cfg_weight: 0.5
        temperature: 0.8
```

### 6. Check status

```bash
npm run status
```

Shows keypair info, session state, and paired/joined channels.

### 7. Start OpenClaw

Restart the OpenClaw gateway. The Copy plugin will:
1. Load your keypair and authenticate
2. Load channel secrets for group channels (recover from server if needed)
3. Connect WebSockets for all channels (pairwise + group)
4. Listen for incoming voice messages
5. Process through the full pipeline and respond with voice

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable the Copy channel |
| `apiUrl` | `https://walkie-talkie-api.matt8066.workers.dev` | Copy backend URL |
| `displayName` | `"OpenClaw"` | Bot display name in Copy |
| `stt.provider` | `"whisper-api"` | STT provider |
| `stt.url` | `"http://localhost:9000"` | Whisper API URL |
| `stt.model` | `"base"` | Whisper model size |
| `stt.language` | `"en"` | Transcription language |
| `tts.provider` | `"chatterbox"` | TTS provider |
| `tts.url` | `"http://localhost:4123"` | Chatterbox server URL |
| `tts.params.exaggeration` | `0.5` | Chatterbox expressiveness |
| `tts.params.cfg_weight` | `0.5` | Chatterbox classifier-free guidance |
| `tts.params.temperature` | `0.8` | Chatterbox sampling temperature |
| `dataDir` | `~/.openclaw/extensions/copy/data/` | Data directory for keypair, session, channels |
| `voicePrompt` | *(built-in)* | System prompt hint for voice-friendly responses |

## Data Directory

```
~/.openclaw/extensions/copy/data/
├── keypair.json          # Ed25519 + X25519 keys (chmod 600)
├── session.json          # JWT session token (auto-refreshes)
├── channels.json         # Paired/joined channel info
├── secrets/              # Group channel secrets
│   └── {channelId}.key   # Symmetric key for each group (chmod 600)
└── tmp/                  # Temporary audio files (cleaned up after each message)
```

## Architecture

The plugin registers as an OpenClaw channel provider. Key components:

- **Copy protocol layer** (`src/copy/`) — crypto, API client, auth, WebSocket, storage, join flow
- **STT providers** (`src/stt/`) — speech-to-text behind an interface (Whisper default)
- **TTS providers** (`src/tts/`) — text-to-speech behind an interface (Chatterbox default)
- **Channel integration** (`src/channel.ts`) — OpenClaw ChannelPlugin implementation, group state management, key rotation
- **Inbound handler** (`src/copy/inbound.ts`) — full pipeline from WS event to reply upload (pairwise + group routing)
- **Join flow** (`src/copy/join.ts`) — invite URL parsing, group join API, key distribution

### Cryptography

| Channel Type | Encryption | Key Exchange | Signatures |
|-------------|-----------|-------------|-----------|
| Pairwise | `crypto_box` (X25519 + XSalsa20-Poly1305) | Diffie-Hellman (keys exchanged at pairing) | None (implicit authentication via DH) |
| Group | `crypto_secretbox` (XSalsa20-Poly1305) | `crypto_box_seal` (anonymous sealed box per member) | Ed25519 over `nonce \|\| ciphertext` |

Group keys are derived via BLAKE2b KDF: `deriveGroupKey(channelSecret)` with context `"COPYGRPK"`.

STT and TTS are behind provider interfaces (`STTProvider`, `TTSProvider`) so additional providers (OpenAI Whisper, Cartesia, ElevenLabs) can be added without changing the pipeline.

## Security

- Private keys never leave the device (`keypair.json` is chmod 600)
- Audio is always encrypted before upload — no plaintext audio on the server
- Group channel secrets stored separately from channel metadata (chmod 600)
- Key rotation happens automatically when a member leaves a group
- The server is zero-knowledge — it stores encrypted blobs, never decrypted audio
