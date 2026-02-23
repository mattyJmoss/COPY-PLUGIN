# @openclaw/channel-copy

OpenClaw channel plugin for **Copy** — the async voice messaging (walkie-talkie) app. Makes any OpenClaw agent a Copy friend that can receive voice messages and respond with voice.

## How It Works

```
Copy app (friend speaks)
  → WebSocket new_message event
  → Download encrypted audio from R2
  → Decrypt (X25519 + XSalsa20-Poly1305)
  → ffmpeg → 16kHz mono WAV
  → Whisper STT (transcribe to text)
  → OpenClaw agent pipeline (full personality, memory, tools)
  → Chatterbox TTS (text → speech)
  → ffmpeg → M4A (64kbps AAC)
  → Encrypt (crypto_box_easy)
  → Upload reply to Copy
```

All audio is end-to-end encrypted using libsodium. The agent's personality, memory, and tools come from OpenClaw automatically.

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

### 3. Pair with a friend

Have your friend generate a Copy pair link, then:

```bash
npm run pair <pair-link-or-token>
```

Accepts:
- Full URL: `https://walkie-talkie-api.matt8066.workers.dev/pair/abc123...`
- Just the token: `abc123def456...`

### 4. Configure OpenClaw

Add to your OpenClaw config (`~/.openclaw/config.yaml`):

```yaml
channels:
  copy:
    enabled: true
    apiUrl: "https://walkie-talkie-api.matt8066.workers.dev"
    displayName: "Murray"

    stt:
      provider: "whisper-api"
      url: "http://bazzite.local:9000"
      model: "base"
      language: "en"

    tts:
      provider: "chatterbox"
      url: "http://bazzite.local:4123"
      params:
        exaggeration: 0.5
        cfg_weight: 0.5
        temperature: 0.8
```

### 5. Check status

```bash
npm run status
```

Shows keypair info, session state, and paired channels.

### 6. Start OpenClaw

Restart the OpenClaw gateway. The Copy plugin will:
1. Load your keypair and authenticate
2. Connect WebSockets for all paired channels
3. Listen for incoming voice messages
4. Process through the full pipeline and respond with voice

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable the Copy channel |
| `apiUrl` | `https://walkie-talkie-api.matt8066.workers.dev` | Copy backend URL |
| `displayName` | `"OpenClaw"` | Bot display name in Copy |
| `stt.provider` | `"whisper-api"` | STT provider |
| `stt.url` | `"http://bazzite.local:9000"` | Whisper API URL |
| `stt.model` | `"base"` | Whisper model size |
| `stt.language` | `"en"` | Transcription language |
| `tts.provider` | `"chatterbox"` | TTS provider |
| `tts.url` | `"http://bazzite.local:4123"` | Chatterbox server URL |
| `tts.params.exaggeration` | `0.5` | Chatterbox expressiveness |
| `tts.params.cfg_weight` | `0.5` | Chatterbox classifier-free guidance |
| `tts.params.temperature` | `0.8` | Chatterbox sampling temperature |
| `dataDir` | `~/.openclaw/extensions/copy/data/` | Data directory for keypair, session, channels |
| `voicePrompt` | *(built-in)* | System prompt hint for voice-friendly responses |

## Data Directory

```
~/.openclaw/extensions/copy/data/
├── keypair.json    # Ed25519 + X25519 keys (chmod 600)
├── session.json    # JWT session token (auto-refreshes)
├── channels.json   # Paired channel/friend info
└── tmp/            # Temporary audio files (cleaned up after each message)
```

## Architecture

The plugin registers as an OpenClaw channel provider. Key components:

- **Copy protocol layer** (`src/copy/`) — crypto, API client, auth, WebSocket, storage
- **STT providers** (`src/stt/`) — speech-to-text behind an interface (Whisper default)
- **TTS providers** (`src/tts/`) — text-to-speech behind an interface (Chatterbox default)
- **Channel integration** (`src/channel.ts`) — OpenClaw ChannelPlugin implementation
- **Inbound handler** (`src/copy/inbound.ts`) — full pipeline from WS event to reply upload

STT and TTS are behind provider interfaces (`STTProvider`, `TTSProvider`) so additional providers (OpenAI Whisper, Cartesia, ElevenLabs) can be added without changing the pipeline.
