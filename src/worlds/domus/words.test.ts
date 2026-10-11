import { describe, expect, it } from "vitest";
import { dropTokens, plainName, textOrUndefined } from "./words.js";

describe("dropTokens: a game token the helper did not format never reaches her", () => {
  it("drops each {...} token with the spaces it leaves, and keeps the rest of the words", () => {
    expect(dropTokens("{0.SimFirstName} went out")).toBe("went out");
    expect(dropTokens("Gave {1.Number} to {0.SimFirstName}.")).toBe("Gave to.");
    expect(dropTokens("No tokens here")).toBe("No tokens here");
  });
});

describe("textOrUndefined: the game's text, trimmed, without tokens", () => {
  it("trims the text, drops its tokens, and is undefined when nothing is left", () => {
    expect(textOrUndefined("  Test {0.SimFirstName}  ")).toBe("Test");
    expect(textOrUndefined("{1.Number}")).toBeUndefined();
    expect(textOrUndefined(4)).toBe("4");
    expect(textOrUndefined(null)).toBeUndefined();
  });
});

describe("plainName: a game name in plain words", () => {
  it("lowers the camel case and the separators of a tuning name", () => {
    expect(plainName("Role_PivotalMoment")).toBe("role pivotal moment");
    expect(plainName("<class 'situations.Role_BirthdayParty'>")).toBe("role birthday party");
  });
});
