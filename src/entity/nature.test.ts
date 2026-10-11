import { describe, expect, it } from "vitest";
import { LAR_NATURE } from "./nature.js";

describe("a Lar's nature", () => {
  it("says the character note wins over it", () => {
    expect(LAR_NATURE).toContain("where the two differ, your character note wins");
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
