import { describe, expect, it } from "vitest";
import type { OptionObject } from "./answers.js";
import { renderView, VIEW_TEXT_MAX } from "./options.js";

// D2: when the view is capped, the objects that serve the most urgent need are kept first, and the view says how many
// objects it left out and how to ask for them. The long text stands in for a whole lot of ordinary objects: one of them
// alone is larger than what the cap leaves for the choices.

const LONG_ACT = "Look at it very closely and turn it over in your hands, again and again. ".repeat(350);

function filler(index: number): OptionObject {
  return {
    object: `Test thing ${index}`,
    object_id: `thing-${index}`,
    room: "Test hall",
    where: `elsewhere, ${index + 1}.0 m`,
    acts: [{ ref: `a${index + 3}`, guid64: `${index + 3}`, text: LONG_ACT }],
  };
}

function toilet(name: string, objectId: string, room: string, metres: number, ref: string, guid: string): OptionObject {
  return {
    object: name,
    object_id: objectId,
    room,
    where: `elsewhere, ${metres}.0 m`,
    serves: ["bladder"],
    acts: [{ ref, guid64: guid, text: "Use the toilet" }],
  };
}

const TOILET_UP = toilet("Test toilet upstairs", "toilet-up", "Test bathroom", 50, "a50", "50");
const TOILET_DOWN = toilet("Test toilet downstairs", "toilet-down", "Test washroom", 60, "a51", "51");
const FILLERS = Array.from({ length: 38 }, (_, index) => filler(index));

describe("the view cap keeps what the most urgent need requires (D2)", () => {
  it("keeps both toilets when the bladder is in distress, and says the left-out count and how to ask", () => {
    const text = renderView({
      world: "slot3",
      percepts: [],
      options: [...FILLERS, TOILET_UP, TOILET_DOWN],
      portrait: { needs: { bladder: { value: 5, band: "distress" } } },
    });
    expect(text).toContain("- Test toilet upstairs (50.0 m): a50 Use the toilet");
    expect(text).toContain("- Test toilet downstairs (60.0 m): a51 Use the toilet");
    expect(text).toContain("38 more things on the lot are not listed, to keep this view short. game_list things shows them.");
    expect(text.length).toBeLessThanOrEqual(VIEW_TEXT_MAX);
  });
});
