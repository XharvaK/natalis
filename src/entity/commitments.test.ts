import { describe, expect, it } from "vitest";
import {
  COMMITMENTS_STUB,
  commitmentBlock,
  HOUSEHOLD_STUB,
  householdForSummoner,
  OLD_COMMITMENTS_STUB,
  protectedNoteReason,
  withCommitment,
  withHouseholdLine,
  withoutHouseholdLine,
} from "./commitments.js";

describe("protectedNoteReason", () => {
  it("refuses the household and commitments notes, with a plain reason for each", () => {
    expect(protectedNoteReason("self/household.md")).toBe("Your summoner writes your household part.");
    expect(protectedNoteReason("self/constitution.md")).toBe("Your commitments change through propose_commitment.");
  });

  it("does not count folder spelling or letter case as a different note", () => {
    expect(protectedNoteReason("./self//household.md")).toBeDefined();
    expect(protectedNoteReason("SELF/Household.MD")).toBeDefined();
    expect(protectedNoteReason("Self/Constitution.md")).toBeDefined();
  });

  it("leaves every other note open", () => {
    expect(protectedNoteReason("self/character.md")).toBeUndefined();
    expect(protectedNoteReason("people/mara.md")).toBeUndefined();
    expect(protectedNoteReason("self/household.md.bak")).toBeUndefined();
  });
});

describe("the household note", () => {
  it("starts from its heading when the note is only the stub, and keeps the line count", () => {
    const added = withHouseholdLine(HOUSEHOLD_STUB, "Mara is my friend.");
    expect(added.text).toBe("# Household\n\n- Mara is my friend.\n");
    expect(added.count).toBe(1);
  });

  it("adds each new line at the end of the note", () => {
    const once = withHouseholdLine(null, "Mara grows beans.");
    const twice = withHouseholdLine(once.text, "Tomas keeps the lamp.");
    expect(twice.text).toBe("# Household\n\n- Mara grows beans.\n- Tomas keeps the lamp.\n");
    expect(twice.count).toBe(2);
  });

  it("removes the n-th line, counting only the lines that start with a dash", () => {
    const note = "# Household\n\nSome words.\n- Mara grows beans.\n- Tomas keeps the lamp.\n";
    const cut = withoutHouseholdLine(note, 2);
    expect(cut).toEqual({ text: "# Household\n\nSome words.\n- Mara grows beans.\n", removed: "Tomas keeps the lamp." });
  });

  it("answers no for a line that is not there", () => {
    expect(withoutHouseholdLine("# Household\n- Mara grows beans.\n", 2)).toBeUndefined();
    expect(withoutHouseholdLine(null, 1)).toBeUndefined();
  });

  it("shows the summoner each line numbered, so it can be removed by number", () => {
    const shown = householdForSummoner("# Household\n\n- Mara grows beans.\n- Tomas keeps the lamp.\n");
    expect(shown).toBe("# Household\n\n[1] Mara grows beans.\n[2] Tomas keeps the lamp.");
    expect(householdForSummoner(null)).toContain("Nothing is written here yet.");
  });
});

describe("the commitments note", () => {
  const block = commitmentBlock(
    { text: "I keep my promises.", why: "People trust me." },
    "2026-10-10",
    "2026-10-11",
  );

  it("writes the block with its dates and reason, in the form the Lar reads", () => {
    expect(block).toBe(
      "- I keep my promises.\n  (proposed 2026-10-10, agreed by your summoner 2026-10-11; why: People trust me.)",
    );
  });

  it("replaces the stub, current or first-release, with a heading and the block", () => {
    expect(withCommitment(COMMITMENTS_STUB, block)).toBe(`# My commitments\n\n${block}\n`);
    expect(withCommitment(OLD_COMMITMENTS_STUB, block)).toBe(`# My commitments\n\n${block}\n`);
    expect(withCommitment(null, block)).toBe(`# My commitments\n\n${block}\n`);
  });

  it("adds a later block after the ones already kept", () => {
    const first = withCommitment(COMMITMENTS_STUB, block);
    const second = withCommitment(first, block.replace("promises", "lamp"));
    expect(second).toBe(`# My commitments\n\n${block}\n\n${block.replace("promises", "lamp")}\n`);
  });
});
