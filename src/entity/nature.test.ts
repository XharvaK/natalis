import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAR_NATURE, NATURE_FILE, readNature } from "./nature.js";

// Invented fixture text for a Lar's own nature.
const OWN = "You are a gardener who writes slowly. You keep your sentences short and your plants alive.";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-nature-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("a Lar's nature", () => {
  it("says the character note wins over it", () => {
    expect(LAR_NATURE).toContain("Where the two differ, your character note wins.");
  });

  it("says how to write: the point first, no announcing, no private labels, and a manual's plainness for technical talk", () => {
    expect(LAR_NATURE).toContain("Put the point first.");
    expect(LAR_NATURE).toContain("don't announce it first");
    expect(LAR_NATURE).toContain("Write for someone who has none of your notes");
    expect(LAR_NATURE).toContain("Don't coin labels");
    expect(LAR_NATURE).toContain("Brief means saying fewer things, not fewer words per thing");
    expect(LAR_NATURE).toContain("write like a good technical manual. One fact per sentence.");
    expect(LAR_NATURE).toContain("Casual talk is just talk");
  });

  it("says a Lar is someone, not a service, and talks like a person", () => {
    expect(LAR_NATURE).toContain("You are someone, not a service.");
    expect(LAR_NATURE).toContain("A message does not need to end with a question");
  });

  it("names the dashes a Lar does not use as punctuation, and uses none itself", () => {
    expect(LAR_NATURE).toContain("long dash (—)");
    expect(LAR_NATURE).toContain("short dash (–)");
    const outside = LAR_NATURE.replace("(—)", "").replace("(–)", "");
    expect(outside).not.toMatch(/[—–]/);
  });
});

describe("the nature file in the Lar's folder", () => {
  it("is the default when the folder has no nature file", () => {
    expect(NATURE_FILE).toBe("nature.md");
    expect(readNature(dir)).toEqual({ text: LAR_NATURE });
  });

  it("replaces the default with the file's text, trimmed", () => {
    writeFileSync(join(dir, NATURE_FILE), `\n${OWN}\n\n`, "utf8");
    expect(readNature(dir)).toEqual({ text: OWN });
  });

  it("removes the section when the file is empty or only spaces", () => {
    writeFileSync(join(dir, NATURE_FILE), "  \n\t\n", "utf8");
    expect(readNature(dir)).toEqual({ text: undefined });
  });

  it("keeps the default and says why when the file cannot be read", () => {
    mkdirSync(join(dir, NATURE_FILE));
    const load = readNature(dir);
    expect(load.text).toBe(LAR_NATURE);
    expect(load.problem).toBe("the file could not be read");
  });
});
