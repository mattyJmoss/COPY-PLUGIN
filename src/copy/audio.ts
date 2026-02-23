/**
 * Audio pipeline utilities.
 *
 * Handles format conversion (ffmpeg), STT, TTS, and the full
 * inbound/outbound audio processing chains.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import type { STTProvider } from "../stt/interface.js";
import type { TTSProvider } from "../tts/interface.js";

const execFileAsync = promisify(execFile);

/** Convert any audio format to 16kHz mono WAV for Whisper. */
export async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-ar", "16000",
    "-ac", "1",
    "-f", "wav",
    outputPath,
  ]);
}

/** Convert WAV to M4A/AAC for Copy playback. */
export async function convertWavToM4a(wavPath: string, m4aPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", wavPath,
    "-c:a", "aac",
    "-b:a", "64k",
    "-ar", "24000",
    "-ac", "1",
    "-f", "ipod",
    m4aPath,
  ]);
}

export interface AudioPipelineResult {
  audioBytes: Buffer;
  transcription: string;
  response: string;
}

/**
 * Process inbound audio: decrypt bytes → WAV → STT → text.
 * Returns the transcription.
 */
export async function transcribeAudio(
  decryptedAudio: Uint8Array,
  stt: STTProvider,
  tmpDir: string,
  tag: string,
  log?: (msg: string) => void,
): Promise<string> {
  const rawPath = path.join(tmpDir, `in-${tag}.audio`);
  const wavPath = path.join(tmpDir, `in-${tag}.wav`);

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(rawPath, decryptedAudio);
    log?.(`[Audio:${tag}] Received ${decryptedAudio.length} bytes`);

    log?.(`[Audio:${tag}] Converting to WAV...`);
    await convertToWav(rawPath, wavPath);

    log?.(`[Audio:${tag}] Transcribing with ${stt.name}...`);
    const wavBytes = await fs.readFile(wavPath);
    const transcription = await stt.transcribe(wavBytes);
    log?.(`[Audio:${tag}] Transcription: "${transcription}"`);

    if (!transcription) {
      throw new Error("Empty transcription — silent or unrecognizable audio");
    }

    return transcription;
  } finally {
    await fs.unlink(rawPath).catch(() => {});
    await fs.unlink(wavPath).catch(() => {});
  }
}

/**
 * Generate reply audio: text → TTS → WAV → M4A bytes.
 */
export async function generateReplyAudio(
  text: string,
  tts: TTSProvider,
  tmpDir: string,
  tag: string,
  log?: (msg: string) => void,
): Promise<Buffer> {
  const ttsWavPath = path.join(tmpDir, `tts-${tag}.wav`);
  const m4aPath = path.join(tmpDir, `out-${tag}.m4a`);

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    log?.(`[Audio:${tag}] Generating TTS with ${tts.name}...`);
    const ttsWav = await tts.synthesize(text);
    await fs.writeFile(ttsWavPath, ttsWav);
    log?.(`[Audio:${tag}] TTS WAV: ${ttsWav.length} bytes`);

    log?.(`[Audio:${tag}] Converting to M4A...`);
    await convertWavToM4a(ttsWavPath, m4aPath);
    const audioBytes = await fs.readFile(m4aPath);
    log?.(`[Audio:${tag}] M4A done: ${audioBytes.length} bytes`);

    return audioBytes;
  } finally {
    await fs.unlink(ttsWavPath).catch(() => {});
    await fs.unlink(m4aPath).catch(() => {});
  }
}
