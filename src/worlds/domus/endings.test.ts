import { describe, expect, it } from "vitest";
import { endingOf } from "./endings.js";

describe("how a finished act ended", () => {
  it("reads the game's completed endings, with or without the enum's prefix", () => {
    expect(endingOf("NATURAL")).toEqual({ ended: "completed" });
    expect(endingOf("FinishingType.SI_FINISHED")).toEqual({ ended: "completed" });
    expect(endingOf("ANSWERED")).toEqual({ ended: "answered" });
    expect(endingOf("ASKED").ended).toBe("asked");
  });

  it("reads a cut-short ending with its reason, and an unknown or missing type as cut short", () => {
    expect(endingOf("USER_CANCEL")).toEqual({ ended: "cut_short", why: "it was cancelled (by you or at the controls)" });
    expect(endingOf(undefined)).toEqual({ ended: "cut_short", why: "the game ended it early" });
    expect(endingOf("SOMETHING_NEW").ended).toBe("cut_short");
  });

  it("says an act that never began never began", () => {
    expect(endingOf("INTERACTION_INCOMPATIBILITY", false).why).toBe("it never began: the game found no way to do it from where you were");
    expect(endingOf("DISPLACED", false).why).toBe("it never began: another action replaced it");
  });
});
