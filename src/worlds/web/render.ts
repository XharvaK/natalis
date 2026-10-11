// Turns a web reply into text the Lar can read: HTML becomes readable text with its links kept, JSON is pretty-printed,
// other text is shown as it is, and anything binary is described and not shown. No judgment about the content lives here.

export type BodyKind = "none" | "json" | "html" | "text" | "binary";

export type ShapedBody = { kind: BodyKind; text: string; parsed?: unknown };

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return fromCode(Number.parseInt(body.slice(2), 16), whole);
    if (body.startsWith("#")) return fromCode(Number.parseInt(body.slice(1), 10), whole);
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function fromCode(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
  return String.fromCodePoint(code);
}

/** Resolves a link against the page it was on; keeps the link as written when it cannot be resolved. */
function absoluteLink(href: string, base: string): string | undefined {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#") || /^javascript:/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

const BLOCK_TAGS = /<\/?(p|div|section|article|header|footer|nav|main|aside|h[1-6]|ul|ol|table|tr|blockquote|pre|hr|br|dt|dd|figure|figcaption|form)\b[^>]*>/gi;

/** HTML to readable text: scripts, styles and markup dropped; links kept as "text (url)"; the page title first. */
export function htmlToText(html: string, baseUrl: string): string {
  let title = "";
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (titleMatch) title = decodeEntities(titleMatch[1]!.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|template|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_whole, attrs: string, inner: string) => {
      const label = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const target = href ? absoluteLink(href[1] ?? href[2] ?? href[3] ?? "", baseUrl) : undefined;
      if (target === undefined) return ` ${label} `;
      return label === "" ? ` (${target}) ` : ` ${label} (${target}) `;
    })
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title === "" ? text : `Title: ${title}\n\n${text}`;
}

function mediaTypeOf(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function isTextType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml") ||
    mediaType === "application/javascript" ||
    mediaType === "application/ecmascript" ||
    mediaType === "application/x-www-form-urlencoded"
  );
}

function isHtmlType(mediaType: string): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function isJsonType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function hasNul(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 4096);
  for (let index = 0; index < limit; index++) if (bytes[index] === 0) return true;
  return false;
}

/** The reply's body as the Lar reads it. `truncated` means the byte cap cut the reply, so it cannot be parsed whole. */
export function readBody(bytes: Uint8Array, contentType: string, baseUrl: string, truncated: boolean): ShapedBody {
  if (bytes.length === 0) return { kind: "none", text: "" };
  const mediaType = mediaTypeOf(contentType);
  const textual = mediaType === "" ? !hasNul(bytes) : isTextType(mediaType);
  if (!textual) {
    const label = mediaType === "" ? "unknown type" : mediaType;
    const size = truncated ? `at least ${bytes.length}` : `${bytes.length}`;
    return { kind: "binary", text: `Binary reply (${label}, ${size} bytes): not shown.` };
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  const looksJson = /^\s*[[{]/.test(text);
  if (!truncated && (isJsonType(mediaType) || (mediaType === "" && looksJson))) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return { kind: "json", text: JSON.stringify(parsed, null, 2), parsed };
    } catch {
      // Not JSON after all: shown as text below.
    }
  }
  if (isHtmlType(mediaType) || (mediaType === "" && /^\s*<(!doctype html|html)\b/i.test(text))) {
    return { kind: "html", text: htmlToText(text, baseUrl) };
  }
  return { kind: "text", text };
}
