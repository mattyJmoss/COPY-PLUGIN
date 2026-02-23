/**
 * TTS (Text-to-Speech) provider interface.
 *
 * Implementations convert text to audio. Default: Chatterbox.
 * Future providers can implement this interface (e.g., Cartesia, ElevenLabs).
 */

export interface TTSProvider {
  /** Human-readable provider name. */
  readonly name: string;

  /**
   * Generate speech audio from text.
   * @param text — the text to speak
   * @returns WAV audio bytes
   */
  synthesize(text: string): Promise<Buffer>;
}
