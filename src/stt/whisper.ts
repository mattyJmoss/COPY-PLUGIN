/**
 * Whisper STT provider — transcribes audio via a faster-whisper HTTP API.
 *
 * Compatible with any OpenAI-compatible /v1/audio/transcriptions endpoint
 * (faster-whisper-server, whisper.cpp server, OpenAI API, etc.)
 */

import type { STTProvider } from "./interface.js";

export interface WhisperConfig {
  url: string;
  model?: string;
  language?: string;
}

export class WhisperSTT implements STTProvider {
  readonly name = "whisper-api";
  private url: string;
  private model: string;
  private language: string;

  constructor(config: WhisperConfig) {
    this.url = config.url.replace(/\/$/, "");
    this.model = config.model ?? "base";
    this.language = config.language ?? "en";
  }

  async transcribe(wavBytes: Buffer): Promise<string> {
    const formData = new FormData();
    const blob = new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" });
    formData.append("file", blob, "audio.wav");
    formData.append("model", this.model);
    formData.append("language", this.language);
    formData.append("response_format", "json");

    const res = await fetch(`${this.url}/v1/audio/transcriptions`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      throw new Error(`Whisper STT error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as { text: string };
    return data.text.trim();
  }
}
