// Turns the words of a say into speakable chunks as they stream in.
// The body never adds or rewrites words: it drops what cannot be spoken (code blocks, emoji, markdown marks) and reads a
// link as its site name, and it reports each of these so the receipt can tell her exactly what was not said aloud.

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx", "no", "jr", "sr", "prof"]);
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic}))*️?/gu;

/** How a chunk of speech ends, which sets its pause. */
export type ChunkEnd = "." | "!" | "?" | "…" | "clause" | "newline" | "final";

/** The silence after each kind of chunk's end, in milliseconds. */
export const PAUSE_MS: Readonly<Record<ChunkEnd, number>> = { ".": 300, "!": 320, "?": 340, "…": 420, clause: 150, newline: 380, final: 0 };

/** One chunk of a say made speakable: the words to speak, and what was left out of them. */
export type SpeechChunk = { raw: string; say: string; skipped: string[]; end: ChunkEnd; pauseMs: number };

/** Makes raw text speakable: what to say, and what was left out of it, in order. */
export function speakable(raw: string): { say: string; skipped: string[] } {
  const skipped: string[] = [];
  let text = raw;
  text = text.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "");
  text = text.replace(/^\s*#{1,6}\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, (_, label: string) => label);
  text = text.replace(/\bhttps?:\/\/([^\s/?#)]+)[^\s)]*/g, (_, host: string) => {
    skipped.push("a link, read as its site name");
    return host.replace(/^www\./, "").split(".").join(" dot ");
  });
  text = text.replace(/`([^`]+)`/g, (_, code: string) => code);
  text = text.replace(/(\*\*|__|~~)(.+?)\1/g, (_, __: string, inner: string) => inner);
  text = text.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s.,!?;:)]|$)/g, (_, pre: string, inner: string) => pre + inner);
  const emoji = text.match(EMOJI);
  if (emoji) {
    skipped.push(emoji.length === 1 ? "an emoji" : `${emoji.length} emoji`);
    text = text.replace(EMOJI, "");
  }
  text = text.replace(/\s+/g, " ").trim();
  return { say: /[\p{L}\p{N}]/u.test(text) ? text : "", skipped };
}

/**
 * Splits streaming text into chunks at sentence ends, line breaks and, for the first chunk only, at a clause mark once
 * enough words are in, so speech can start early. Code fences are dropped whole and reported.
 */
export function createChunker(options: {
  onChunk: (chunk: SpeechChunk) => void;
  firstClauseWords?: number;
  maxWords?: number;
}): { push(fragment: string): void; finish(): void } {
  const { onChunk, firstClauseWords = 10, maxWords = 32 } = options;
  let buffer = "";
  let inFence = false;
  let fenceLines = 0;
  let emitted = 0;

  function emit(raw: string, end: ChunkEnd): void {
    const { say, skipped } = speakable(raw);
    if (say.length > 0 || skipped.length > 0) onChunk({ raw, say, skipped, end, pauseMs: PAUSE_MS[end] ?? 0 });
    if (say.length > 0) emitted += 1;
  }

  function words(s: string): number {
    return s.trim().split(/\s+/).filter(Boolean).length;
  }

  function sentenceEnd(s: string, final: boolean): { at: number; end: ChunkEnd } | null {
    for (let i = 0; i < s.length; i += 1) {
      const ch = s.charAt(i);
      if (ch === "\n") return { at: i + 1, end: "newline" };
      if (".!?…".includes(ch)) {
        let j = i + 1;
        while (j < s.length && ".!?…\"')”’".includes(s.charAt(j))) j += 1;
        const end: ChunkEnd = ch === "…" ? "…" : ch === "!" ? "!" : ch === "?" ? "?" : /^\.{3,}/.test(s.slice(i, j)) ? "…" : ".";
        if (j >= s.length) return final ? { at: j, end } : null; // need the next character to be sure
        if (!/\s/.test(s.charAt(j))) continue; // 12.5, a.m, example.com
        if (ch === ".") {
          const word = s.slice(0, i).split(/\s/).pop()?.toLowerCase() ?? "";
          if (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word)) continue;
        }
        return { at: j, end };
      }
    }
    return null;
  }

  function clauseCut(s: string, minWords: number): number | null {
    let best: number | null = null;
    const re = /[,;:—–](?=\s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) if (words(s.slice(0, m.index)) >= minWords) best = m.index + 1;
    return best;
  }

  function drain(final: boolean): void {
    for (;;) {
      if (inFence) {
        const close = buffer.indexOf("```");
        if (close === -1) {
          fenceLines += (buffer.match(/\n/g) ?? []).length;
          buffer = buffer.endsWith("`") ? buffer.slice(buffer.lastIndexOf("\n") + 1) : "";
          if (final) onChunk({ raw: "", say: "", skipped: ["a code block that never closed"], end: "final", pauseMs: 0 });
          return;
        }
        fenceLines += (buffer.slice(0, close).match(/\n/g) ?? []).length;
        const lines = Math.max(1, fenceLines - 1);
        onChunk({ raw: "", say: "", skipped: [`a code block (${lines} line${lines === 1 ? "" : "s"})`], end: "newline", pauseMs: 0 });
        buffer = buffer.slice(close + 3).replace(/^[^\n]*\n?/, "");
        inFence = false;
        continue;
      }
      const fence = buffer.indexOf("```");
      const head = fence === -1 ? buffer : buffer.slice(0, fence);
      const cut = sentenceEnd(head, final || fence !== -1);
      if (cut !== null && cut.at <= head.length) {
        emit(head.slice(0, cut.at), cut.end);
        buffer = buffer.slice(cut.at);
        continue;
      }
      if (fence !== -1) {
        if (head.trim()) emit(head, "newline");
        buffer = buffer.slice(fence + 3);
        inFence = true;
        fenceLines = 0;
        continue;
      }
      const n = words(head);
      if (emitted === 0 && n >= firstClauseWords) {
        const at = clauseCut(head, 4);
        if (at !== null) {
          emit(head.slice(0, at), "clause");
          buffer = buffer.slice(at);
          continue;
        }
      }
      if (n > maxWords) {
        const at = clauseCut(head, 6) ?? head.split(/(?<=\s)/).slice(0, maxWords).join("").length;
        emit(head.slice(0, at), "clause");
        buffer = buffer.slice(at);
        continue;
      }
      if (final) {
        if (head.trim()) emit(head, "final");
        buffer = "";
      }
      return;
    }
  }

  return {
    push(fragment) {
      buffer += fragment;
      drain(false);
    },
    finish() {
      drain(true);
    },
  };
}

/** The whole text at once: push, then finish. */
export function speechChunks(text: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  const chunker = createChunker({ onChunk: (chunk) => chunks.push(chunk) });
  chunker.push(text);
  chunker.finish();
  return chunks;
}
