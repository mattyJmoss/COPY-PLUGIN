/**
 * Chatterbox TTS provider — generates speech via the Chatterbox TTS server.
 *
 * Returns WAV audio bytes.
 */

import type { TTSProvider } from "./interface.js";

export interface ChatterboxConfig {
  url: string;
  params?: {
    exaggeration?: number;
    cfg_weight?: number;
    temperature?: number;
  };
}

export class ChatterboxTTS implements TTSProvider {
  readonly name = "chatterbox";
  private url: string;
  private exaggeration: number;
  private cfgWeight: number;
  private temperature: number;

  constructor(config: ChatterboxConfig) {
    this.url = config.url.replace(/\/$/, "");
    this.exaggeration = config.params?.exaggeration ?? 0.5;
    this.cfgWeight = config.params?.cfg_weight ?? 0.5;
    this.temperature = config.params?.temperature ?? 0.8;
  }

  async synthesize(text: string): Promise<Buffer> {
    const res = await fetch(`${this.url}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        exaggeration: this.exaggeration,
        cfg_weight: this.cfgWeight,
        temperature: this.temperature,
        stream_format: null,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "(no body)");
      throw new Error(`Chatterbox TTS error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }
}
