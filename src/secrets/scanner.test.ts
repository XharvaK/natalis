import { describe, expect, it } from "vitest";
import { createSecretScanner } from "./scanner.js";

// Every credential-shaped literal is built from parts at runtime, so this file never contains a token-shaped string.
const GH_PAT = "gh" + "p_" + "a".repeat(36);
const GH_OAUTH = "gh" + "o_" + "B1".repeat(18);
const GH_FINE = "github" + "_pat_" + "x1Y2z3W4".repeat(3);
const AWS = "AK" + "IA" + "0123456789ABCDEF";
const OPENAI = "s" + "k-" + "a1B2c3D4e5F6g7H8i9J0k1";
const OPENAI_PROJ = "s" + "k-" + "proj-" + "a".repeat(24);
const SLACK = "xo" + "xb-" + "1234567890-ABCDEFGHIJ";
const DISCORD = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "Abcdef", "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"].join(".");
const PEM_BEGIN = "-----BEGIN " + "RSA " + "PRIVATE KEY-----";
const PEM_END = "-----END " + "RSA " + "PRIVATE KEY-----";
const JWT = "eyJ" + "hbGciOi.abc123.def456";
const URL_CREDS = "https://" + "user" + ":" + "s3cretpass" + "@" + "host.example/path";

describe("secret scanner: shapes", () => {
  const cases: Array<[string, string]> = [
    ["github_pat", GH_PAT],
    ["github_oauth", GH_OAUTH],
    ["github_fine_grained_pat", GH_FINE],
    ["aws_access_key", AWS],
    ["openai_sk", OPENAI],
    ["openai_sk", OPENAI_PROJ],
    ["slack_token", SLACK],
    ["discord_bot_token", DISCORD],
    ["pem_private_key", `${PEM_BEGIN}\nMIIBOgIBAAJBAKj34GkxFhD\n${PEM_END}`],
    ["bearer_jwt", `Authorization: Bearer ${JWT}`],
    ["bearer_token", `authorization: bearer ${"abcDEF123" + "ghiJKL456" + "mnoPQR789"}`],
    ["generic_api_key_assignment", `api_key = ${"abcdefghij" + "klmnopqrst" + "1234"}`],
    ["recovery_codes_block", `recovery codes: ${"ABCD-EFGH-JKLM"} ${"QRST-UVWX-YZ12"}`],
    ["url_credentials", URL_CREDS],
  ];

  it.each(cases)("hits %s", (kind, text) => {
    const hits = createSecretScanner().scan(text);
    expect(hits.map((h) => h.kind)).toContain(kind);
  });

  it("a hit spans exactly the secret", () => {
    const text = `token is ${GH_PAT} ok`;
    const hits = createSecretScanner().scan(text);
    expect(hits).toEqual([{ kind: "github_pat", start: 9, end: 9 + GH_PAT.length }]);
    expect(text.slice(hits[0]!.start, hits[0]!.end)).toBe(GH_PAT);
  });

  it("finds an empty text as nothing", () => {
    expect(createSecretScanner().scan("")).toEqual([]);
  });
});

describe("secret scanner: no false positives on ordinary prose", () => {
  it.each([
    "The quick brown fox wrote a diary entry about the weather in the morning.",
    "Bearer of good news arrived at the door before noon today.",
    "The task-list has twelve items and the risk-assessment is done.",
    "sk-learn is a library for machine learning, and it is free.",
    "See https://example.com/path?x=1 or https://example.com:8080/docs for more.",
    "Recovery codes are kept in the drawer; ask the owner for them.",
    "The api key was rotated last week, so update the config file by hand.",
    "Ana walks at dawn, and the bakery opens at seven in the morning.",
  ])("no hit: %s", (prose) => {
    expect(createSecretScanner().scan(prose)).toEqual([]);
  });
});

describe("secret scanner: known values", () => {
  it("matches a known value literally", () => {
    const scanner = createSecretScanner({ knownValues: ["house-door-code-2026"] });
    const hits = scanner.scan("the code is house-door-code-2026, do not share");
    expect(hits).toEqual([{ kind: "known_value", start: 12, end: 12 + "house-door-code-2026".length }]);
  });

  it("addKnownValue adds a value after creation", () => {
    const scanner = createSecretScanner();
    expect(scanner.scan("my pet name is Biscuit9")).toEqual([]);
    scanner.addKnownValue("Biscuit9");
    expect(scanner.scan("my pet name is Biscuit9")).toHaveLength(1);
  });

  it("refuses a known value shorter than 8 characters, loudly", () => {
    expect(() => createSecretScanner({ knownValues: ["short"] })).toThrow(RangeError);
    expect(() => createSecretScanner().addKnownValue("1234567")).toThrow(RangeError);
  });

  it("matches case-sensitively", () => {
    const scanner = createSecretScanner({ knownValues: ["Biscuit9"] });
    expect(scanner.scan("biscuit9")).toEqual([]);
  });
});

describe("secret scanner: merging and redaction", () => {
  it("merges overlapping hits into one, sorted, non-overlapping", () => {
    const scanner = createSecretScanner({ knownValues: ["abcdefghijklmnop", "ghijklmnopqrstuv"] });
    const hits = scanner.scan("xx abcdefghijklmnopqrstuv yy");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ kind: "known_value", start: 3, end: 3 + 22 });
  });

  it("keeps separate hits separate and sorted by start", () => {
    const scanner = createSecretScanner({ knownValues: ["second-value-here", "first-value-here"] });
    const text = "first-value-here then second-value-here";
    const hits = scanner.scan(text);
    expect(hits.map((h) => h.start)).toEqual([0, text.indexOf("second-value-here")]);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.start).toBeGreaterThanOrEqual(hits[i - 1]!.end);
  });

  it("redacts each hit to [secret:<kind>] and leaves the rest of the text alone", () => {
    const scanner = createSecretScanner({ knownValues: ["house-door-code-2026"] });
    const text = `token ${GH_PAT} and code house-door-code-2026 end`;
    expect(scanner.redact(text)).toBe("token [secret:github_pat] and code [secret:known_value] end");
  });

  it("returns ordinary prose unchanged", () => {
    const text = "Nothing to hide in this sentence.";
    expect(createSecretScanner().redact(text)).toBe(text);
  });
});

describe("secret scanner: JSON-escaped known values", () => {
  // Built from parts: a quote, a backslash and a newline, the characters JSON.stringify escapes.
  const FAKE = ["fake", '"', "key", "\\", "tail", "\n", "end"].join("");
  const ESCAPED = JSON.stringify(FAKE).slice(1, -1);

  it("matches a known value echoed in its JSON-escaped form, inside JSON text", () => {
    const scanner = createSecretScanner({ knownValues: [FAKE] });
    const text = `{"k":"${ESCAPED}"}`;
    const hits = scanner.scan(text);
    expect(hits.map((h) => h.kind)).toEqual(["known_value"]);
    expect(scanner.redact(text)).toBe('{"k":"[secret:known_value]"}');
  });

  it("matches the raw value and the escaped form in plain text alike", () => {
    const scanner = createSecretScanner({ knownValues: [FAKE] });
    expect(scanner.redact(`raw ${FAKE} and escaped ${ESCAPED} end`)).toBe(
      "raw [secret:known_value] and escaped [secret:known_value] end",
    );
  });

  it("addKnownValue also covers the escaped form", () => {
    const scanner = createSecretScanner();
    scanner.addKnownValue(FAKE);
    expect(scanner.redact(`echo ${ESCAPED}`)).toBe("echo [secret:known_value]");
  });

  it("leaves a value with nothing to escape as it was", () => {
    const plain = "house-door-code-2026";
    const scanner = createSecretScanner({ knownValues: [plain] });
    expect(scanner.redact(`code ${plain}`)).toBe("code [secret:known_value]");
  });
});
