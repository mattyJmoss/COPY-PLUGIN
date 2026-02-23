/**
 * STT (Speech-to-Text) provider interface.
 *
 * Implementations convert audio to text. Default: Whisper API.
 * Future providers can implement this interface (e.g., OpenAI, Deepgram).
 */

export interface STTProvider {
  /** Human-readable provider name. */
  readonly name: string;

  /**
   * Transcribe audio to text.
   * @param wavBytes — 16kHz mono WAV audio bytes
   * @returns transcribed text
   */
  transcribe(wavBytes: Buffer): Promise<string>;
}
