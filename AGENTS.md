# Copy OpenClaw Channel Plugin - Build Instructions

## What You're Building
An OpenClaw channel plugin that connects to Copy (async voice messaging app). This makes any OpenClaw agent a Copy friend — receive voice messages, respond with voice.

## Reference Materials
1. **Current working Copy client source:** `/tmp/copy-plugin-build/reference/src/` — This is the working Murray Copy Client. Study every file.
2. **Campfire plugin (OpenClaw plugin reference):** `/tmp/copy-plugin-build/campfire-reference-src/` — Shows how OpenClaw channel plugins are structured
3. **Plugin manifest example:** `/tmp/copy-plugin-build/campfire-reference-plugin.json`  
4. **Campfire package.json:** `/tmp/copy-plugin-build/campfire-reference-package.json`
5. **Campfire tsconfig.json:** `/tmp/copy-plugin-build/campfire-reference-tsconfig.json`
6. **Full proposal:** (see project docs)

## Phase 1 Scope (MVP)
1. Restructure existing Copy client into OpenClaw channel plugin structure
2. Model after the Campfire plugin architecture (openclaw.plugin.json, index.ts, channel registration)
3. Inbound: Copy voice message → download → decrypt → STT (Whisper) → send to OpenClaw pipeline as text
4. Outbound: OpenClaw text response → TTS (Chatterbox) → encrypt → upload to Copy
5. Keep Whisper and Chatterbox as default providers but behind interfaces (STTProvider, TTSProvider)
6. CLI commands: register, pair, status
7. Data dir: ~/.openclaw/extensions/copy/data/

## Key Architectural Points
- Copy messages are AUDIO — inbound needs STT, outbound needs TTS
- All libsodium crypto (Ed25519 + X25519) stays as-is — it's Copy protocol
- WebSocket per channel with reconnect stays as-is
- Use OpenClaw's channel API for brain interaction (NOT raw /v1/chat/completions)
- The agent's personality comes from OpenClaw automatically via channel integration

## Packaging for Others
This MUST be installable by someone else (Jeremiah/Dross). Include:
- Clear README.md with setup steps (register, pair, configure STT/TTS)
- openclaw.plugin.json with config schema
- CLI commands that guide through setup

## Build Requirements
- TypeScript, compiles with tsc
- npm run build should succeed
- Match the Campfire plugin's package.json/tsconfig.json patterns for OpenClaw compatibility

When completely finished, run: openclaw system event --text "Done: Copy OpenClaw plugin Phase 1 MVP built and compiles" --mode now
