/**
 * Sanitize LLM responses for voice output.
 *
 * Strips patterns that sound like gibberish when read aloud by TTS:
 * stack traces, code blocks, file paths, long machine-output lines, and URLs.
 * Keeps conversational prose intact — the goal is removing noise, not summarising.
 */

const FALLBACK = "I ran into an error and couldn't summarize it cleanly.";

/**
 * Sanitize text for voice output.
 * Returns cleaned text or a fallback if nothing meaningful remains.
 */
export function sanitizeForVoice(text: string): string {
  const originalLength = text.length;
  let result = text;

  // ── 1. Fenced code blocks (``` ... ```) → spoken placeholder ──
  result = result.replace(/```[\s\S]*?```/g, " — [code block omitted] — ");

  // ── 2. JS/TS stack trace lines (    at Module.fn (/path/to/file.js:12:34)) ──
  result = result.replace(/^\s+at\s+\S.*$/gm, "");

  // ── 3. Named error lines (Error: ..., TypeError: ..., etc.) ──
  result = result.replace(
    /(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT):[^\n]*/g,
    "",
  );

  // ── 4. Lines that look like machine output ──
  //    a) Long lines (>200 chars) with no spaces — e.g. base64, minified JS
  //    b) Absolute filesystem paths (/home/..., /Users/..., /var/..., ~/...)
  //    c) file:// URLs
  result = result
    .split("\n")
    .filter((line) => {
      // Long line with no spaces
      if (line.length > 200 && !/\s/.test(line)) return false;
      // File system paths that start the line or follow whitespace
      if (/(?:^|\s)(\/(?:home|Users|var|etc|usr|tmp|opt|root)\/\S+)/.test(line)) return false;
      // file:// URLs
      if (/file:\/\/\S+/.test(line)) return false;
      return true;
    })
    .join("\n");

  // ── 5. https:// URLs (keep domain-only mentions if possible, strip full URLs) ──
  result = result.replace(/https?:\/\/\S+/g, "");

  // ── 6. Inline code (`...`) ──
  result = result.replace(/`[^`\n]+`/g, "");

  // ── 7. ~/... paths ──
  result = result.replace(/~\/\S+/g, "");

  // ── 8. JSON / structured data blobs ──
  result = result.replace(/\{[^}]{20,}\}/g, "");
  result = result.replace(/\[[^\]]{20,}\]/g, "");

  // ── 9. Markdown formatting → keep inner text ──
  result = result
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, "$1") // bold/italic
    .replace(/_{1,3}([^_\n]+)_{1,3}/g, "$1") // underscore bold/italic
    .replace(/^#{1,6}\s+/gm, "") // headers
    .replace(/^[\s]*[-*]\s+/gm, "") // bullets
    .replace(/^[\s]*\d+\.\s+/gm, ""); // numbered lists

  // ── 10. Collapse whitespace ──
  result = result.replace(/\n{2,}/g, "\n").replace(/[ \t]+/g, " ").trim();

  // ── 11. If original was long but result is tiny, it was probably an error dump ──
  if (originalLength > 500 && result.length < 100 && result.length > 0) {
    result = "I ran into an error. " + result;
  }

  return result || FALLBACK;
}
