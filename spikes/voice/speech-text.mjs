// Turns the words of a say into speakable chunks as they stream in.
// The body never adds or rewrites words: it drops what cannot be spoken (code blocks, emoji, markdown marks) and reads a
// link as its site name, and it reports each of these so the receipt can tell her exactly what was not said aloud.

const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "approx", "no", "jr", "sr", "prof"]);
const PAUSE_MS = { ".": 300, "!": 320, "?": 340, "…": 420, clause: 150, newline: 380, final: 0 };
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍(?:\p{Extended_Pictographic}))*️?/gu;

/** One chunk of a say made speakable: the words to speak, and what was left out of them. */
export function speakable(raw) {
  const skipped = [];
  let text = raw;
  text = text.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "");
  text = text.replace(/^\s*#{1,6}\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, (_, label) => label);
  text = text.replace(/\bhttps?:\/\/([^\s/?#)]+)[^\s)]*/g, (_, host) => {
    skipped.push("a link, read as its site name");
    return host.replace(/^www\./, "").split(".").join(" dot ");
  });
  text = text.replace(/`([^`]+)`/g, (_, code) => code);
  text = text.replace(/(\*\*|__|~~)(.+?)\1/g, (_, __, inner) => inner);
  text = text.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s.,!?;:)]|$)/g, (_, pre, inner) => pre + inner);
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
export function createChunker({ onChunk, firstClauseWords = 10, maxWords = 32 }) {
  let buffer = "";
  let inFence = false;
  let fenceLines = 0;
  let emitted = 0;

  function emit(raw, end) {
    const { say, skipped } = speakable(raw);
    if (say.length > 0 || skipped.length > 0) onChunk({ raw, say, skipped, end, pauseMs: PAUSE_MS[end] ?? 0 });
    if (say.length > 0) emitted += 1;
  }

  function words(s) {
    return s.trim().split(/\s+/).filter(Boolean).length;
  }

  function sentenceEnd(s, final) {
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === "\n") return { at: i + 1, end: "newline" };
      if (".!?…".includes(ch)) {
        let j = i + 1;
        while (j < s.length && ".!?…\"')”’".includes(s[j])) j += 1;
        if (j >= s.length) return final ? { at: j, end: ch } : null; // need the next character to be sure
        if (!/\s/.test(s[j])) continue; // 12.5, a.m, example.com
        if (ch === ".") {
          const word = s.slice(0, i).split(/\s/).pop().toLowerCase();
          if (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word)) continue;
        }
        return { at: j, end: ch };
      }
    }
    return null;
  }

  function clauseCut(s, minWords) {
    let best = null;
    const re = /[,;:—–](?=\s)/g;
    let m;
    while ((m = re.exec(s)) !== null) if (words(s.slice(0, m.index)) >= minWords) best = m.index + 1;
    return best;
  }

  function drain(final) {
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
        if (at !== null) { emit(head.slice(0, at), "clause"); buffer = buffer.slice(at); continue; }
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
    push(fragment) { buffer += fragment; drain(false); },
    finish() { drain(true); },
  };
}
