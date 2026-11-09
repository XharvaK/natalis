import { describe, expect, it } from "vitest";
import { noteSections } from "../notebook/sections.js";
import { editedStamp, lifeView } from "./life-view.js";

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

describe("N1: a last-edited stamp under each heading", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
  const stampOf = (section: { title: string }) =>
    section.title === "Garden" ? editedStamp(NOW - 8 * DAY, NOW, "UTC") : section.title === "Work" ? undefined : editedStamp(NOW - 1000, NOW, "UTC");

  it("says the date and how many days ago, and today for today", () => {
    expect(editedStamp(NOW - 8 * DAY, NOW, "UTC")).toBe("(last edited 2026-10-26, 8 days ago)");
    expect(editedStamp(NOW - DAY, NOW, "UTC")).toBe("(last edited 2026-11-02, 1 day ago)");
    expect(editedStamp(NOW - 1000, NOW, "UTC")).toBe("(last edited 2026-11-03, today)");
  });

  it("counts calendar days in the Lar's timezone, not elapsed 24-hour blocks (NB-1)", () => {
    // 23:00 in Europe/Istanbul (UTC+3) on 2 Nov, checked at 01:00 the next calendar day.
    const edited = Date.parse("2026-11-02T20:00:00Z");
    const nextMorning = Date.parse("2026-11-02T22:00:00Z");
    expect(editedStamp(edited, nextMorning, "Europe/Istanbul")).toBe("(last edited 2026-11-02, 1 day ago)");
    const sameEvening = Date.parse("2026-11-02T20:30:00Z");
    expect(editedStamp(edited, sameEvening, "Europe/Istanbul")).toBe("(last edited 2026-11-02, today)");
  });

  it("puts the stamp on the line after each heading in the whole view, and none where the time is not known", () => {
    const view = lifeView(LIFE, "", { switchChars: 10_000, viewChars: 10_000, stampOf });
    expect(view.text).toContain("## Garden\n(last edited 2026-10-26, 8 days ago)\n\nI grow beans");
    expect(view.text).toContain("# Life\n(last edited 2026-11-03, today)\n");
    expect(view.text).toContain("## Work\n\nI work at the bakery");
    // Her words are all still there, unchanged.
    expect(view.text.replace(/\n\(last edited [^)]*\)/g, "")).toBe(LIFE.trim());
  });

  it("stamps the sections shown in the switched view, and leaves the pointer lines alone", () => {
    const view = lifeView(LIFE, "beans", { switchChars: 10, viewChars: 120, stampOf });
    expect(view.mode).toBe("sections");
    expect(view.text).toContain("## Garden\n(last edited 2026-10-26, 8 days ago)");
    expect(view.text).not.toContain("section: ## Boats\n(last edited");
  });

  it("is the old view exactly when no stamps are asked for", () => {
    expect(lifeView(LIFE, "", { switchChars: 10_000, viewChars: 10_000 }).text).toBe(LIFE.trim());
  });
});
