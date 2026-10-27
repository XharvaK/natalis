import { describe, expect, it } from "vitest";
import { noteSections, sectionOf } from "./sections.js";

// Invented people and places only.
const NOTE = [
  "# Life",
  "",
  "My brief: I live by the harbour.",
  "",
  "## Work",
  "",
  "I work at the bakery on Quay Street.",
  "",
  "## Garden",
  "",
  "I grow beans by the harbour.",
  "",
].join("\n");

describe("sections of a note", () => {
  it("finds every heading line and takes its whole section up to the next heading", () => {
    const sections = noteSections(NOTE);

    expect(sections.map((section) => section.heading)).toEqual(["# Life", "## Work", "## Garden"]);
    expect(sections.map((section) => section.title)).toEqual(["Life", "Work", "Garden"]);
    expect(sections[1]?.text).toBe("## Work\n\nI work at the bakery on Quay Street.");
  });

  it("finds a section by its heading line or by its bare title, and returns it whole", () => {
    expect(sectionOf(NOTE, "## Work")?.text).toBe("## Work\n\nI work at the bakery on Quay Street.");
    expect(sectionOf(NOTE, "Work")?.text).toBe("## Work\n\nI work at the bakery on Quay Street.");
    expect(sectionOf(NOTE, "  ## Garden  ")?.text).toBe("## Garden\n\nI grow beans by the harbour.");
  });

  it("has no sections for a note with no headings, and finds nothing in it", () => {
    const plain = "Just words.\nMore words.";
    expect(noteSections(plain)).toEqual([]);
    expect(sectionOf(plain, "Work")).toBeUndefined();
  });

  it("keeps CRLF text readable: the heading has no carriage return and the section text is the note's", () => {
    const crlf = "# Life\r\n\r\n## Work\r\n\r\nI work at the bakery.\r\n";
    const sections = noteSections(crlf);
    expect(sections.map((section) => section.heading)).toEqual(["# Life", "## Work"]);
    expect(sections[1]?.text).toBe("## Work\r\n\r\nI work at the bakery.");
    expect(sectionOf(crlf, "Work")?.text).toBe("## Work\r\n\r\nI work at the bakery.");
  });
});
