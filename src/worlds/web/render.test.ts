import { describe, expect, it } from "vitest";
import { htmlToText, readBody } from "./render.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("htmlToText", () => {
  it("drops scripts, styles and markup, decodes entities and keeps the title first", () => {
    const html =
      "<html><head><title>Harbour &amp; lamp</title><style>p{color:red}</style></head>" +
      "<body><script>track()</script><p>Hello &amp; welcome &#65;&#x42;.</p><!-- hidden --></body></html>";
    const text = htmlToText(html, "https://example.org/");
    expect(text).toBe("Title: Harbour & lamp\n\nHello & welcome AB.");
    expect(text).not.toContain("track");
    expect(text).not.toContain("color");
    expect(text).not.toContain("hidden");
  });

  it("keeps links as text (url), resolves relative links and drops fragment and script links", () => {
    const html =
      "<p><a href='/about'>About us</a> and <a href=\"https://example.net/x\">Elsewhere</a>" +
      "<a href='#top'>Top</a> <a href='javascript:void(0)'>Click</a><a href='/bare'></a></p>";
    const text = htmlToText(html, "https://example.org/page");
    expect(text).toContain("About us (https://example.org/about)");
    expect(text).toContain("Elsewhere (https://example.net/x)");
    expect(text).toContain("Top");
    expect(text).not.toContain("#top");
    expect(text).toContain("Click");
    expect(text).not.toContain("javascript");
    expect(text).toContain("(https://example.org/bare)");
  });

  it("renders 512 KiB of each hostile unclosed pattern in under a second", () => {
    const size = 512 * 1024;
    const patterns = [
      "<!--",
      '<a href="https://example.org/x">',
      "<script>",
      "<style>",
      "<title>",
      "<a",
      "<",
      "<li <p <div",
    ];
    for (const pattern of patterns) {
      const hostile = pattern.repeat(Math.ceil(size / pattern.length));
      const started = Date.now();
      htmlToText(hostile, "https://example.org/");
      expect(Date.now() - started, pattern).toBeLessThan(1000);
    }
  });

  it("keeps an unclosed opener as it was: a stray tag goes and its text stays", () => {
    expect(htmlToText("<a href='/x'>Kept", "https://example.org/")).toBe("Kept");
    expect(htmlToText("Before <script>after", "https://example.org/")).toBe("Before after");
    expect(htmlToText("Before <!-- x > after", "https://example.org/")).toBe("Before after");
    expect(htmlToText("Before <!-- hidden? after", "https://example.org/")).toBe("Before <!-- hidden? after");
  });

  it("turns list items and blocks into lines", () => {
    const text = htmlToText("<ul><li>one</li><li>two</li></ul><div>three</div>", "https://example.org/");
    expect(text.split("\n").filter((line) => line !== "")).toEqual(["- one", "- two", "three"]);
  });
});

describe("readBody", () => {
  it("pretty-prints JSON and keeps the parsed value", () => {
    const shaped = readBody(encode('{"a":1,"b":[2]}'), "application/json; charset=utf-8", "https://example.org/", false);
    expect(shaped.kind).toBe("json");
    expect(shaped.text).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(shaped.parsed).toEqual({ a: 1, b: [2] });
  });

  it("shows a truncated JSON reply as text, because it cannot be read whole", () => {
    const shaped = readBody(encode('{"a":'), "application/json", "https://example.org/", true);
    expect(shaped.kind).toBe("text");
    expect(shaped.text).toBe('{"a":');
  });

  it("converts an HTML reply and shows plain text as it is", () => {
    expect(readBody(encode("<h1>Hi</h1>"), "text/html", "https://example.org/", false)).toEqual({ kind: "html", text: "Hi" });
    expect(readBody(encode("plain words"), "text/plain", "https://example.org/", false)).toEqual({ kind: "text", text: "plain words" });
  });

  it("describes binary replies and does not show them", () => {
    const png = readBody(new Uint8Array([137, 80, 78, 71]), "image/png", "https://example.org/", false);
    expect(png.kind).toBe("binary");
    expect(png.text).toBe("Binary reply (image/png, 4 bytes): not shown.");
    const unlabelled = readBody(new Uint8Array([0, 1, 2]), "", "https://example.org/", false);
    expect(unlabelled.kind).toBe("binary");
  });

  it("reads an empty reply as no body, and an unlabelled text reply as text", () => {
    expect(readBody(new Uint8Array(), "text/plain", "https://example.org/", false)).toEqual({ kind: "none", text: "" });
    expect(readBody(encode("just text"), "", "https://example.org/", false)).toEqual({ kind: "text", text: "just text" });
  });
});
