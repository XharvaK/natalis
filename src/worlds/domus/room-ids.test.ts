import { describe, expect, it } from "vitest";
import type { OptionObject } from "./answers.js";
import { renderView } from "./options.js";
import { parseObservation } from "./wire.js";

const NOW = 1_700_000_000_000;

function view(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    observation_id: "obs-1",
    world: "slot3",
    branch: "main",
    session: "s1",
    attachment: "a1",
    body: "b1",
    snapshot: "none",
    seq: 1,
    source_time_ms: NOW,
    expires_at_ms: NOW + 60_000,
    lineage_class: "LIVE",
    percepts: [{ kind: "presence", salience: 0.5, facts: { bucket: "here" } }],
    ...extra,
  };
}

describe("D6: short room ids and same-named objects in different rooms", () => {
  const kitchen: OptionObject = {
    object: "Pool seat", object_id: "9000", where: "elsewhere, 4.0 m", room: "Kitchen", room_id: "r1",
    acts: [{ ref: "a1", guid64: "8100", text: "Sit" }],
  };
  const hall: OptionObject = {
    object: "Pool seat", object_id: "9001", where: "elsewhere, 4.5 m", room: "Hall", room_id: "r2",
    acts: [{ ref: "a2", guid64: "8100", text: "Sit" }],
  };
  const near: OptionObject = {
    object: "Test kettle", object_id: "11", where: "here, 1.0 m", near: true, room: "Kitchen", room_id: "r1",
    acts: [{ ref: "a3", guid64: "1", text: "Boil water" }],
  };

  it("prints rN with the room label, and lists same-named objects in different rooms separately", () => {
    const text = renderView({ percepts: [], options: [kitchen, hall] });
    expect(text).toContain("r1 Kitchen:");
    expect(text).toContain("r2 Hall:");
    expect(text).toContain("- Pool seat (4.0 m): a1 Sit");
    expect(text).toContain("- Pool seat (4.5 m): a2 Sit");
    expect(text).not.toContain("of them in");
  });

  it("names the room on a near object as well", () => {
    const text = renderView({ percepts: [], options: [near] });
    expect(text).toContain("- Test kettle (here, 1.0 m, r1 Kitchen): a3 Boil water");
  });

  it("accepts a short room id on the wire and refuses a wrong shape", () => {
    const option = { object: "Chair", object_id: "1", acts: [{ ref: "a1", guid64: "1", text: "Sit" }] };
    const parsed = parseObservation(view({ options: [{ ...option, room: "Kitchen", room_id: "r3" }] }), NOW);
    expect(parsed.options?.[0]).toMatchObject({ room: "Kitchen", room_id: "r3" });
    for (const extra of [{ room_id: "Kitchen" }, { room_id: "r" }, { room_id: "r123456789" }, { room_id: "" }, { room_id: 3 }]) {
      expect(() => parseObservation(view({ options: [{ ...option, ...extra }] }), NOW)).toThrow();
    }
  });
});
