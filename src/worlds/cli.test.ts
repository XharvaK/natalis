import { describe, expect, it } from "vitest";
import type { WorldEvent } from "../contracts.js";
import { CLI_NOW, CLI_PLACE, createCliWorld } from "./cli.js";

describe("the command-line world", () => {
  it("turns a typed line into an owner event at its place", async () => {
    const events: WorldEvent[] = [];
    const cli = createCliWorld({ onSay: () => {} });
    await cli.start((event) => events.push(event));
    cli.send("Hello, Iris.");
    expect(events).toEqual([
      { world: "cli", place: CLI_PLACE, actor: "owner", source: "owner", text: "Hello, Iris." },
    ]);
    await cli.stop();
  });

  it("refuses to send before it starts, and refuses an empty line", async () => {
    const cli = createCliWorld({ onSay: () => {} });
    expect(() => cli.send("too early")).toThrow(/not started/);
    await cli.start(() => {});
    expect(() => cli.send("   ")).toThrow(/line is empty/);
  });

  it("shows what the entity says and answers ok", async () => {
    const shown: Array<[string, string]> = [];
    const cli = createCliWorld({ onSay: (place, text) => shown.push([place, text]) });
    const receipt = await cli.say(CLI_PLACE, "Good morning.");
    expect(receipt.ok).toBe(true);
    expect(shown).toEqual([[CLI_PLACE, "Good morning."]]);
  });

  it("reports a failure to show as a refusal, not a crash", async () => {
    const cli = createCliWorld({
      onSay: () => {
        throw new Error("the terminal is closed");
      },
    });
    const receipt = await cli.say(CLI_PLACE, "Hello?");
    expect(receipt.ok).toBe(false);
    expect(receipt.refused?.code).toBe("world_error");
  });

  it("counts only its own command-line place as the owner place", () => {
    const cli = createCliWorld({ onSay: () => {} });
    expect(cli.isOwnerPlace?.(CLI_PLACE)).toBe(true);
    expect(cli.isOwnerPlace?.("cli:someone-else")).toBe(false);
    expect(cli.isOwnerPlace?.("discord:dm:owner")).toBe(false);
  });

  it("offers no tools and a fixed now line", () => {
    const cli = createCliWorld({ onSay: () => {} });
    expect(cli.tools()).toEqual([]);
    expect(cli.now()).toBe("Command line: open.");
    expect(CLI_NOW).toBe("Command line: open.");
  });
});
