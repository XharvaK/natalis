import { describe, expect, it } from "vitest";
import { capText, OUTPUT_CHARS, OutputCollector } from "./output.js";

describe("capText", () => {
  it("leaves text of up to 16,000 characters as it is", () => {
    expect(capText("short")).toBe("short");
    expect(capText("a".repeat(OUTPUT_CHARS))).toBe("a".repeat(OUTPUT_CHARS));
  });

  it("keeps the head and the tail and says how many characters are left out in the middle", () => {
    const text = "H".repeat(10_000) + "T".repeat(10_000);
    const capped = capText(text);
    expect(capped).toBe(`${"H".repeat(8_000)}\n…4000 characters left out…\n${"T".repeat(8_000)}`);
  });

  it("counts one character left out when the text is one over the limit", () => {
    const capped = capText("x".repeat(OUTPUT_CHARS + 1));
    expect(capped).toContain("…1 characters left out…");
    expect(capped.startsWith("x".repeat(8_000))).toBe(true);
    expect(capped.endsWith("x".repeat(8_000))).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    // A high surrogate sits exactly where the head would end; the head stops one character sooner.
    const text = "x".repeat(7_999) + "\u{1F600}" + "y".repeat(20_000);
    const capped = capText(text);
    expect(capped.startsWith("x".repeat(7_999) + "\n")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(capped)).toBe(false);
  });
});

describe("OutputCollector", () => {
  it("collects chunks and decodes them as UTF-8, across chunk boundaries", () => {
    const collector = new OutputCollector();
    const bytes = Buffer.from("café ok\n", "utf8");
    expect(collector.push(bytes.subarray(0, 4))).toBe(true);
    expect(collector.push(bytes.subarray(4))).toBe(true);
    expect(collector.text()).toBe("café ok\n");
  });

  it("refuses the chunk that takes it over its byte cap and keeps nothing past that point", () => {
    const collector = new OutputCollector(10);
    expect(collector.push(Buffer.from("123456"))).toBe(true);
    expect(collector.push(Buffer.from("7890AB"))).toBe(false);
    expect(collector.text()).toBe("123456");
  });
});
