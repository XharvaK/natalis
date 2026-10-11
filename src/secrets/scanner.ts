// The secret scanner: a byte check for credentials, never a judgment. It finds shapes (a key that looks like
// a key) and known values (strings the creator registered). It does not decide whether a hit is harmful.

import type { SecretHit, SecretScanner } from "../contracts.js";

type Pattern = { kind: string; re: RegExp };

// Patterns ported from the Ashley privacy-core shapes, plus the token families this kit must also hold.
// Every regex is written with `g` so `matchAll` finds each occurrence.
const SOURCE_PATTERNS: Array<{ kind: string; source: string; flags: string }> = [
  {
    kind: "pem_private_key",
    source: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\\s\\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    flags: "",
  },
  { kind: "aws_access_key", source: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b", flags: "" },
  { kind: "github_pat", source: "\\bghp_[A-Za-z0-9]{36,}\\b", flags: "" },
  { kind: "github_oauth", source: "\\bgho_[A-Za-z0-9]{36,}\\b", flags: "" },
  { kind: "github_fine_grained_pat", source: "\\bgithub_pat_[A-Za-z0-9_]{22,}\\b", flags: "" },
  { kind: "slack_token", source: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", flags: "" },
  {
    kind: "discord_bot_token",
    source: "\\b[A-Za-z0-9_-]{24,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{27,}\\b",
    flags: "",
  },
  {
    kind: "bearer_jwt",
    source: "\\bBearer\\s+eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b",
    flags: "i",
  },
  {
    // A bearer token must carry a digit: ordinary prose with the word "bearer" does not.
    kind: "bearer_token",
    source: "\\bbearer\\s+(?=[A-Za-z0-9._~+/-]*\\d)[A-Za-z0-9._~+/-]{20,}=*",
    flags: "i",
  },
  { kind: "openai_sk", source: "\\bsk-[A-Za-z0-9]{20,}\\b", flags: "" },
  { kind: "openai_sk", source: "\\bsk-(?:proj|ant)-[A-Za-z0-9_-]{20,}", flags: "" },
  {
    kind: "generic_api_key_assignment",
    source: "\\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\\s*[:=]\\s*['\"]?[A-Za-z0-9_\\-/.+=]{20,}['\"]?",
    flags: "i",
  },
  {
    kind: "recovery_codes_block",
    source: "\\brecovery codes?\\b[\\s\\S]{0,40}(?:\\b[A-Z0-9]{4,}-[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})?\\b.*){2,}",
    flags: "i",
  },
  {
    // scheme://user:password@host, with a password present.
    kind: "url_credentials",
    source: "\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s:/@]+:[^\\s/@]+@[^\\s/]+",
    flags: "i",
  },
];

const PATTERNS: Pattern[] = SOURCE_PATTERNS.map((p) => ({
  kind: p.kind,
  re: new RegExp(p.source, p.flags + "g"),
}));

export const KNOWN_VALUE_KIND = "known_value";
export const MIN_KNOWN_VALUE_LENGTH = 8;

export type SecretScannerOptions = { knownValues?: string[] };

export type CreatedSecretScanner = SecretScanner & {
  /** Register a value the creator wants hidden. Values shorter than 8 characters are refused, not guessed at. */
  addKnownValue(value: string): void;
};

function checkKnownValue(value: string): void {
  if (typeof value !== "string" || value.length < MIN_KNOWN_VALUE_LENGTH) {
    throw new RangeError(`A known value must be a string of at least ${MIN_KNOWN_VALUE_LENGTH} characters.`);
  }
}

/** Sort by start, longest first at the same start; merge any hits that overlap into one. */
function mergeOverlapping(raw: SecretHit[]): SecretHit[] {
  const sorted = [...raw].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretHit[] = [];
  for (const hit of sorted) {
    const last = merged[merged.length - 1];
    if (last && hit.start < last.end) {
      // The merged hit keeps the kind of the earliest-starting (then longest) hit it absorbed.
      last.end = Math.max(last.end, hit.end);
    } else {
      merged.push({ kind: hit.kind, start: hit.start, end: hit.end });
    }
  }
  return merged;
}

export function createSecretScanner(options: SecretScannerOptions = {}): CreatedSecretScanner {
  const known: string[] = [];

  const addKnownValue = (value: string): void => {
    checkKnownValue(value);
    if (!known.includes(value)) known.push(value);
  };

  for (const value of options.knownValues ?? []) addKnownValue(value);

  const scan = (text: string): SecretHit[] => {
    if (!text) return [];
    const raw: SecretHit[] = [];
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern.re)) {
        const start = match.index ?? 0;
        if (match[0].length === 0) continue;
        raw.push({ kind: pattern.kind, start, end: start + match[0].length });
      }
    }
    for (const value of known) {
      let at = text.indexOf(value);
      while (at !== -1) {
        raw.push({ kind: KNOWN_VALUE_KIND, start: at, end: at + value.length });
        at = text.indexOf(value, at + 1);
      }
    }
    return mergeOverlapping(raw);
  };

  const redact = (text: string): string => {
    const hits = scan(text);
    if (hits.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const hit of hits) {
      out += text.slice(cursor, hit.start) + `[secret:${hit.kind}]`;
      cursor = hit.end;
    }
    return out + text.slice(cursor);
  };

  return { scan, redact, addKnownValue };
}
