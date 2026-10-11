import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMITMENTS_PATH, COMMITMENTS_STUB, HOUSEHOLD_PATH } from "./commitments.js";
import { answerSummoner, HELP_TEXT, isSummonerCommand, type Proposal, type SummonerDesk } from "./summoner.js";
import { isStopOn, writeStop } from "./stop.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";

// Invented fixtures: a harbour lamp kept by Tomas, and a gardener named Mara.
const NOW = Date.parse("2026-10-11T09:00:00Z");

let root: string;
let dir: string;
let notebook: MemoryNotebook;
let proposals: Proposal[];
let rows: string[];
let stopChanges: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-summoner-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  notebook = new MemoryNotebook({ nowMs: () => NOW });
  proposals = [];
  rows = [];
  stopChanges = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function desk(): SummonerDesk {
  return {
    dir,
    notebook,
    timeZone: "UTC",
    nowMs: () => NOW,
    proposals: () => proposals,
    setProposals: (next) => {
      proposals = next;
    },
    record: (text) => {
      rows.push(text);
    },
    stopChanged: () => {
      stopChanges += 1;
    },
  };
}

function run(text: string): Promise<string> {
  return answerSummoner(text, desk());
}

function pending(id: string, text: string, why = "Because it matters."): Proposal {
  return { id, text, why, atMs: Date.parse("2026-10-10T08:00:00Z"), thread: "cli:summoner" };
}

describe("isSummonerCommand", () => {
  it("is true only for a message that starts with !", () => {
    expect(isSummonerCommand("  !stop")).toBe(true);
    expect(isSummonerCommand("please !stop")).toBe(false);
    expect(isSummonerCommand("")).toBe(false);
    expect(isSummonerCommand(undefined)).toBe(false);
  });
});

describe("the stop commands", () => {
  it("turns the stop on with its reason, and records one row about it", async () => {
    const reply = await run("!stop Checking the noise.");
    expect(isStopOn(dir)).toBe(true);
    expect(reply).toContain("Emergency stop is on");
    expect(reply).toContain("Reason: Checking the noise.");
    expect(rows).toEqual(["Your summoner turned on the emergency stop: outward acts are paused. Reason: Checking the noise."]);
    expect(stopChanges).toBe(1);
  });

  it("lifts the stop, and says so when there was none to lift", async () => {
    writeStop(dir, "Busy.");
    expect(await run("!resume")).toBe("Emergency stop is off. The Lar's outward acts can go on again.");
    expect(isStopOn(dir)).toBe(false);
    expect(await run("!resume")).toBe("The emergency stop was not on.");
    expect(rows.at(-1)).toBe("Your summoner tried to turn off the emergency stop, but it was not on.");
  });
});

describe("the household commands", () => {
  it("adds a line, writes it as the summoner, and numbers it in the answer", async () => {
    expect(await run("!household add Mara grows beans.")).toBe("Added to the household note as line 1.");
    expect(await run("!household add Tomas keeps the lamp.")).toBe("Added to the household note as line 2.");
    expect(notebook.read(HOUSEHOLD_PATH)).toBe("# Household\n\n- Mara grows beans.\n- Tomas keeps the lamp.\n");
    const last = notebook.log.at(-1);
    expect(last).toMatchObject({ path: HOUSEHOLD_PATH, reason: "Summoner added a household line", author: "summoner" });
    expect(rows.at(-1)).toBe("Your summoner added a line to your household note: Tomas keeps the lamp.");
  });

  it("shows the note with its lines numbered", async () => {
    await run("!household add Mara grows beans.");
    const shown = await run("!household");
    expect(shown).toContain("Household note:");
    expect(shown).toContain("[1] Mara grows beans.");
  });

  it("removes the line with the given number, and refuses one that is not there", async () => {
    await run("!household add Mara grows beans.");
    await run("!household add Tomas keeps the lamp.");
    expect(await run("!household remove 1")).toBe("Removed household line 1.");
    expect(notebook.read(HOUSEHOLD_PATH)).toBe("# Household\n\n- Tomas keeps the lamp.\n");
    expect(rows.at(-1)).toBe("Your summoner removed a line from your household note: Mara grows beans.");
    expect(await run("!household remove 5")).toBe("There is no household line 5. !household shows the lines.");
    expect(rows.at(-1)).toBe("Your summoner tried to remove household line 5, which is not there.");
  });

  it("answers a household command with no usable words with the usage, and records nothing", async () => {
    const before = rows.length;
    expect(await run("!household add")).toContain("Give the line after add");
    expect(await run("!household remove")).toContain("Give the number of the line");
    expect(await run("!household remove two")).toContain("Give the number of the line");
    expect(await run("!household sing")).toContain("Use !household");
    expect(rows.length).toBe(before);
  });

  it("refuses a household line that is too long, and writes nothing", async () => {
    const reply = await run(`!household add ${"x".repeat(301)}`);
    expect(reply).toContain("at most 300 characters");
    expect(notebook.read(HOUSEHOLD_PATH)).toBeNull();
  });
});

describe("the proposal commands", () => {
  it("lists the waiting proposals with their ids, and says so when there are none", async () => {
    expect(await run("!proposals")).toBe("No commitments are waiting for an answer.");
    proposals = [pending("abc12345", "I keep my promises.")];
    const listed = await run("!proposals");
    expect(listed).toContain("- abc12345: I keep my promises.");
    expect(listed).toContain("why: Because it matters.");
  });

  it("agrees to a proposal: writes it into the commitments with both dates and the reason, and clears it", async () => {
    proposals = [pending("abc12345", "I keep my promises.", "People trust me.")];
    expect(await run("!approve abc12345")).toBe("Agreed. The commitment is now kept with the Lar's commitments.");
    expect(notebook.read(COMMITMENTS_PATH)).toBe(
      "# My commitments\n\n- I keep my promises.\n  (proposed 2026-10-10, agreed by your summoner 2026-10-11; why: People trust me.)\n",
    );
    expect(proposals).toEqual([]);
    expect(rows.at(-1)).toBe("Your summoner agreed to your proposed commitment abc12345: I keep my promises.");
  });

  it("keeps the agreed blocks after the ones before them", async () => {
    await notebook.write(COMMITMENTS_PATH, COMMITMENTS_STUB, "start", "body");
    proposals = [pending("aaaa1111", "First."), pending("bbbb2222", "Second.")];
    await run("!approve aaaa1111");
    await run("!approve bbbb2222");
    const text = notebook.read(COMMITMENTS_PATH) ?? "";
    expect(text.indexOf("- First.")).toBeLessThan(text.indexOf("- Second."));
    expect(text.startsWith("# My commitments\n\n")).toBe(true);
  });

  it("declines a proposal with its reason in the row the Lar sees, and writes nothing into the commitments", async () => {
    proposals = [pending("abc12345", "I keep my promises.")];
    expect(await run("!decline abc12345 Not yet, let us talk first.")).toBe(
      "Declined. Nothing was written into the commitments.",
    );
    expect(proposals).toEqual([]);
    expect(notebook.read(COMMITMENTS_PATH)).toBeNull();
    expect(rows.at(-1)).toBe(
      "Your summoner declined your proposed commitment abc12345: I keep my promises. Reason: Not yet, let us talk first.",
    );
  });

  it("refuses an id that is not waiting, in plain words, and keeps the other proposals", async () => {
    proposals = [pending("abc12345", "I keep my promises.")];
    expect(await run("!approve zzzz9999")).toContain("No commitment is waiting with the id zzzz9999.");
    expect(await run("!decline zzzz9999")).toContain("No commitment is waiting with the id zzzz9999.");
    expect(proposals.map((item) => item.id)).toEqual(["abc12345"]);
    expect(await run("!approve")).toContain("Give the id of the commitment");
  });
});

describe("help and unknown words", () => {
  it("lists the commands", async () => {
    expect(await run("!help")).toBe(HELP_TEXT);
    expect(HELP_TEXT).toContain("!household add <line>");
    expect(rows.at(-1)).toBe("Your summoner asked for the list of commands.");
  });

  it("answers an unknown word with the plain line, and records nothing", async () => {
    expect(await run("!dance")).toBe("I don't know that command. !help lists them.");
    expect(await run("!")).toBe("I don't know that command. !help lists them.");
    expect(rows).toEqual([]);
    expect(isStopOn(dir)).toBe(false);
  });

  it("reads the command word without regard to case", async () => {
    expect(await run("!STOP")).toContain("Emergency stop is on");
    expect(isStopOn(dir)).toBe(true);
  });
});
