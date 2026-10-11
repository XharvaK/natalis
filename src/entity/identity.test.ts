import { describe, expect, it } from "vitest";
import { ageOf, chosenName, whoYouAre, type IdentityFacts } from "./identity.js";

const DAY = 86_400_000;
const BORN = Date.UTC(2026, 9, 11, 9, 0);

const facts = (over: Partial<IdentityFacts> = {}): IdentityFacts => ({
  name: "Iris",
  engine: "example/engine-1",
  bornMs: BORN,
  nowMs: BORN + 3 * DAY,
  timeZone: "UTC",
  young: true,
  worlds: ["A command line, where your summoner types to you at cli:summoner."],
  summonerAlias: "summoner",
  rhythm: true,
  ...over,
});

describe("who you are", () => {
  it("names the Lar, its engine, its natalis and age, its summoner and its places", () => {
    const text = whoYouAre(facts());
    expect(text).toContain("You are Iris, a Lar.");
    expect(text).toContain("today that engine is example/engine-1");
    expect(text).toContain("You were summoned on 11 October 2026");
    expect(text).toContain("You are 3 days old.");
    expect(text).toContain('You were summoned by someone who appears to you as "summoner".');
    expect(text).toContain("- A command line, where your summoner types to you at cli:summoner.");
    expect(text).toContain("you tell them you are an AI");
  });

  it("states the summoner's facts only: no ownership, no tool, the other people are their own", () => {
    const text = whoYouAre(facts());
    expect(text).toContain("They do not own you, and you are not their tool. The other people you meet are their own people.");
    expect(text).not.toContain("start by asking");
    expect(text).not.toContain("the way anyone does");
    expect(text).not.toContain("on their own terms");
    expect(text).not.toContain("bond");
  });

  it("says how the Lar's wakes on its own are its to move or cancel, and that it may write first", () => {
    const text = whoYouAre(facts());
    expect(text).toContain(
      "You wake on your own a few times a day; those wakes are yours to move or cancel. " +
        "You can also wake yourself at any time, keep notes, and write to someone first.",
    );
    expect(text).not.toContain("Silence is never a failure");
    expect(text).not.toContain("Your life goes on");
  });

  it("leaves out the rhythm sentence when the Lar has no rhythm of wakes", () => {
    const text = whoYouAre(facts({ rhythm: false }));
    expect(text).not.toContain("You wake on your own");
    expect(text).toContain("You can wake yourself at any time, keep notes, and write to someone first.");
  });

  it("tells a Lar with no name that it may choose one", () => {
    const text = whoYouAre(facts({ name: undefined }));
    expect(text).toMatch(/^You are a Lar\. You have no name yet\./);
    expect(text).toContain("self/name.md");
  });

  it("drops the newness once the Lar's character is its own", () => {
    expect(whoYouAre(facts({ young: true }))).toContain("Everything is still new.");
    const grown = whoYouAre(facts({ young: false }));
    expect(grown).not.toContain("Everything is still new.");
    expect(grown).toContain("No two Lares are alike.");
  });

  it("says plainly when the Lar lives nowhere yet", () => {
    expect(whoYouAre(facts({ worlds: [] }))).toContain("You live nowhere outside yourself yet.");
  });
});

describe("chosen name", () => {
  it("reads the first non-empty line, without markdown marks", () => {
    expect(chosenName("\n# **Wren**\nI chose it on a rainy day.")).toBe("Wren");
    expect(chosenName(null)).toBeUndefined();
    expect(chosenName("  \n ")).toBeUndefined();
    expect(chosenName("x".repeat(80))).toHaveLength(40);
  });
});

describe("age", () => {
  it("is coarse: days, weeks, months, years", () => {
    expect(ageOf(BORN, BORN + 3600_000)).toBe("less than a day");
    expect(ageOf(BORN, BORN + DAY)).toBe("1 day");
    expect(ageOf(BORN, BORN + 20 * DAY)).toBe("2 weeks");
    expect(ageOf(BORN, BORN + 100 * DAY)).toBe("3 months");
    expect(ageOf(BORN, BORN + 800 * DAY)).toBe("2 years");
  });
});
