import { describe, expect, it } from "vitest";
import { noteSections } from "../notebook/sections.js";
import { lifeView } from "./life-view.js";

// Invented people and places only.
const LIFE = [
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
  "## Boats",
  "",
  "I keep a boat at the point.",
  "",
].join("\n");

function sectionsOf(text: string) {
  const sections = noteSections(text);
  return {
    headings: sections.map((section) => section.heading),
    texts: sections.map((section) => section.text),
  };
}

describe("the life view", () => {
  it("shows the whole file below the switch", () => {
    const view = lifeView(LIFE, "I work at the bakery.", { switchChars: 10_000, viewChars: 10 });

    expect(view.mode).toBe("whole");
    expect(view.needsHeadings).toBe(false);
    expect(view.text).toBe(LIFE.trim());
    expect(view.shownSections).toEqual([]);
    expect(view.hiddenSections).toEqual([]);
  });

  it("over the switch shows the first part whole, then ranked whole sections, then the other headings", () => {
    const { texts } = sectionsOf(LIFE);
    const firstPart = LIFE.slice(0, noteSections(LIFE)[1]?.start).trim();
    const work = texts[1] as string;
    const garden = texts[2] as string;
    // Both sections fit one at a time, but only one fits beside the first part. The query names the garden.
    const viewChars = firstPart.length + 2 + Math.max(work.length, garden.length);

    const view = lifeView(LIFE, "I grow beans by the harbour.", { switchChars: 100, viewChars });

    expect(view.mode).toBe("sections");
    expect(view.firstPart).toBe(firstPart);
    expect(view.shownSections.map((section) => section.heading)).toEqual(["## Garden"]);
    expect(view.hiddenSections.map((section) => section.heading)).toEqual(["## Work", "## Boats"]);
    expect(view.text).toContain(firstPart);
    expect(view.text).toContain(garden);
    expect(view.text).toContain("read_note self/life.md section: ## Work");
    expect(view.text).toContain("read_note self/life.md section: ## Boats");
    expect(view.text).not.toContain("I work at the bakery on Quay Street.");
    expect(view.text).not.toContain("I keep a boat at the point.");
  });

  it("keeps file order when the query shares no words with the sections", () => {
    const { texts } = sectionsOf(LIFE);
    const firstPart = LIFE.slice(0, noteSections(LIFE)[1]?.start).trim();
    const work = texts[1] as string;
    const garden = texts[2] as string;
    const viewChars = firstPart.length + 2 + Math.max(work.length, garden.length);

    const view = lifeView(LIFE, "nothing here matches", { switchChars: 100, viewChars });

    expect(view.shownSections.map((section) => section.heading)).toEqual(["## Work"]);
  });

  it("counts a shared word whatever punctuation surrounds it", () => {
    const { texts } = sectionsOf(LIFE);
    const firstPart = LIFE.slice(0, noteSections(LIFE)[1]?.start).trim();
    const work = texts[1] as string;
    const garden = texts[2] as string;
    const viewChars = firstPart.length + 2 + Math.max(work.length, garden.length);

    const view = lifeView(LIFE, "Beans?", { switchChars: 100, viewChars });

    expect(view.shownSections.map((section) => section.heading)).toEqual(["## Garden"]);
  });

  it("shows no text that is not exactly as the file spells it", () => {
    const view = lifeView(LIFE, "bakery boat beans", { switchChars: 100, viewChars: 10_000 });

    expect(LIFE).toContain(view.firstPart);
    for (const section of view.shownSections) expect(LIFE).toContain(section.text);
    expect(view.text).not.toContain("[Truncated:");
  });

  it("takes the first part before the second heading, or before the first heading when the file starts with text", () => {
    const withoutIntro = lifeView(LIFE, "", { switchChars: 100, viewChars: 10_000 });
    expect(withoutIntro.firstPart).toBe("# Life\n\nMy brief: I live by the harbour.");

    const withIntro = "A note before any heading.\n\n## Work\n\nBakery.\n\n## Garden\n\nBeans.\n";
    const view = lifeView(withIntro, "", { switchChars: 10, viewChars: 10_000 });
    expect(view.firstPart).toBe("A note before any heading.");
    expect(view.shownSections.map((section) => section.heading)).toEqual(["## Work", "## Garden"]);
  });

  it("keeps the first part even when it alone is larger than the view budget, and names the rest", () => {
    const file = `# Life\n\n${"b".repeat(300)}\n\n## Work\n\nBakery.\n`;
    const view = lifeView(file, "", { switchChars: 100, viewChars: 50 });

    expect(view.firstPart).toBe(`# Life\n\n${"b".repeat(300)}`);
    expect(view.shownSections).toEqual([]);
    expect(view.hiddenSections.map((section) => section.heading)).toEqual(["## Work"]);
    expect(view.text).toContain(view.firstPart);
    expect(view.text).toContain("read_note self/life.md section: ## Work");
  });

  it("keeps a file with no headings whole and says the view needs headings", () => {
    const plain = `I live by the harbour. ${"n".repeat(200)}`;
    const view = lifeView(plain, "harbour", { switchChars: 100, viewChars: 50 });

    expect(view.mode).toBe("whole");
    expect(view.needsHeadings).toBe(true);
    expect(view.text).toBe(plain.trim());
  });
});
