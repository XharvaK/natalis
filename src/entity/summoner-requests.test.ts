import { beforeEach, describe, expect, it } from "vitest";
import { answerSummoner, HELP_TEXT, isSummonerCommand, type Proposal, type SummonerDesk } from "./summoner.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import type { Shelf } from "../media/shelf.js";

// Invented fixtures: a gardener named Mara, a harbour lamp, and a body-change request about waking.
const NOW = Date.parse("2026-10-11T09:00:00Z");
const WAKE = "proposals/wake-ids.md";
const USAGE_FILE = "Give one file name under proposals/: !requests <file> or !answer <file> <text>.";
const USAGE_ANSWER = "Give the file and your answer: !answer <file> <text>. !requests lists them.";

let notebook: MemoryNotebook;
let proposals: Proposal[];
let rows: string[];
let stopChanges: number;
let answers: Array<[string, string]>;
let shelf: Shelf;

beforeEach(() => {
  notebook = new MemoryNotebook({ nowMs: () => NOW });
  proposals = [];
  rows = [];
  stopChanges = 0;
  answers = [];
  shelf = {
    dir: "memory://shelf",
    keep: () => {
      throw new Error("the summoner tests keep no pictures");
    },
    list: () => [],
    get: () => undefined,
    pathOf: () => undefined,
    base64Of: () => undefined,
    forget: () => false,
    summary: () => ({ count: 0, bytes: 0 }),
  };
});

function desk(extra: Partial<SummonerDesk> = {}): SummonerDesk {
  return {
    dir: "memory://lar",
    notebook,
    timeZone: "UTC",
    nowMs: () => NOW,
    proposals: () => proposals,
    setProposals: (next) => {
      proposals = next;
    },
    pictures: shelf,
    record: (text) => {
      rows.push(text);
    },
    stopChanged: () => {
      stopChanges += 1;
    },
    ...extra,
  };
}

function run(text: string, extra: Partial<SummonerDesk> = {}): Promise<string> {
  return answerSummoner(text, desk(extra));
}

async function write(path: string, text: string): Promise<void> {
  await notebook.write(path, text, "fixture", "owner");
}

// A safe stand-in for the runtime's secret scanner: it hides the word the fixture calls a secret.
const secret = "harbour-code";
function fakeRedact(text: string): string {
  return text.split(secret).join("[hidden]");
}

describe("!requests", () => {
  it("lists the files under proposals/ with their titles, in name order", async () => {
    await write("proposals/wake-ids.md", "# Wake ids\n\nLet me see who is awake.\n");
    await write("proposals/read-mail.md", "# Read the household mail\n\nLet me open the letters.\n");
    const reply = await run("!requests");
    expect(reply.split("\n")[0]).toBe("Her requests (proposals/):");
    expect(reply.split("\n").slice(1, 3)).toEqual([
      "- read-mail.md: Read the household mail",
      "- wake-ids.md: Wake ids",
    ]);
    expect(reply.split("\n").at(-1)).toBe("Show one with !requests <file>. Answer with !answer <file> <text>.");
  });

  it("clips a long title to 80 characters with ...", async () => {
    const long = "A".repeat(120);
    await write("proposals/long.md", `# ${long}\n`);
    const line = (await run("!requests")).split("\n")[1] ?? "";
    expect(line).toBe(`- long.md: ${"A".repeat(80)}...`);
  });

  it("says plainly when the folder holds no files", async () => {
    expect(await run("!requests")).toBe("There are no requests under proposals/.");
    await write("proposals/inner/deep.md", "# Not directly under proposals/\n");
    expect(await run("!requests")).toBe("There are no requests under proposals/.");
  });

  it("shows one file by bare name or by its proposals/ path", async () => {
    await write(WAKE, "# Wake ids\n\nLet me see who is awake.\n");
    const expected = "proposals/wake-ids.md:\n\n# Wake ids\n\nLet me see who is awake.\n";
    expect(await run("!requests wake-ids")).toBe(expected);
    expect(await run("!requests proposals/wake-ids.md")).toBe(expected);
    expect(await run("!requests wake-ids.md")).toBe(expected);
  });

  it("clips a long file to 1,800 characters and says how much is left", async () => {
    await write(WAKE, `# Wake ids\n\n${"x".repeat(2000)}`);
    const reply = await run("!requests wake-ids");
    expect(reply.startsWith("proposals/wake-ids.md:\n\n# Wake ids\n\n")).toBe(true);
    expect(reply.split("\n").at(-1)).toBe("(cut: 212 more characters. Read the rest with natalis proposals on the host.)");
  });

  it("shows the file through redact when the desk has one", async () => {
    await write(WAKE, `# Wake ids\n\nThe code is ${secret}.\n`);
    const reply = await run("!requests wake-ids", { redact: fakeRedact });
    expect(reply).toContain("The code is [hidden].");
    expect(reply).not.toContain(secret);
  });

  it("lists the names when the file is not there", async () => {
    await write(WAKE, "# Wake ids\n");
    expect(await run("!requests read-mail")).toBe(
      "There is no proposals/read-mail. Files there: wake-ids.md.",
    );
    expect(await run("!requests read-mail")).not.toContain("wake-ids.md.md");
  });

  it("says the folder is empty when a missing file is asked for in an empty proposals/", async () => {
    expect(await run("!requests read-mail")).toBe(
      "There is no proposals/read-mail. There are no requests under proposals/.",
    );
  });

  it("refuses a name with /, \\ or .. with the usage line", async () => {
    await write(WAKE, "# Wake ids\n");
    expect(await run("!requests ../x")).toBe(USAGE_FILE);
    expect(await run("!requests a/b")).toBe(USAGE_FILE);
    expect(await run("!requests ..")).toBe(USAGE_FILE);
  });
});

describe("!answer", () => {
  it("answers one request and calls answerRequest once with the plain file name", async () => {
    await write(WAKE, "# Wake ids\n");
    const extra = {
      answerRequest: (file: string, text: string) => {
        answers.push([file, text]);
      },
    };
    expect(await run("!answer wake-ids Yes, built.", extra)).toBe(
      "Answered proposals/wake-ids.md. She is told in her own thread, and it wakes her.",
    );
    expect(answers).toEqual([["wake-ids.md", "Yes, built."]]);
  });

  it("accepts the proposals/ prefix and keeps the whole answer text", async () => {
    await write(WAKE, "# Wake ids\n");
    const extra = {
      answerRequest: (file: string, text: string) => {
        answers.push([file, text]);
      },
    };
    expect(await run("!answer proposals/wake-ids.md Yes, built. Use 40.", extra)).toContain("Answered proposals/wake-ids.md.");
    expect(answers).toEqual([["wake-ids.md", "Yes, built. Use 40."]]);
  });

  it("does not call answerRequest for a missing file, and lists the names", async () => {
    await write(WAKE, "# Wake ids\n");
    const extra = {
      answerRequest: (file: string, text: string) => {
        answers.push([file, text]);
      },
    };
    expect(await run("!answer read-mail Yes.", extra)).toBe(
      "There is no proposals/read-mail. Files there: wake-ids.md.",
    );
    expect(answers).toEqual([]);
  });

  it("gives the usage line when the text is missing", async () => {
    await write(WAKE, "# Wake ids\n");
    expect(await run("!answer wake-ids")).toBe(USAGE_ANSWER);
    expect(await run("!answer")).toBe(USAGE_ANSWER);
    expect(await run("!answer wake-ids   ")).toBe(USAGE_ANSWER);
  });

  it("refuses an unsafe name with the usage line and calls nothing", async () => {
    const extra = {
      answerRequest: (file: string, text: string) => {
        answers.push([file, text]);
      },
    };
    expect(await run("!answer ../x Yes.", extra)).toBe(USAGE_FILE);
    expect(await run("!answer a/b Yes.", extra)).toBe(USAGE_FILE);
    expect(answers).toEqual([]);
  });

  it("says answering is not wired when the desk has no answerRequest", async () => {
    await write(WAKE, "# Wake ids\n");
    expect(await run("!answer wake-ids Yes, built.")).toBe("Answering is not wired in this body yet.");
  });

  it("answers with the error's message when answerRequest throws", async () => {
    await write(WAKE, "# Wake ids\n");
    const extra = {
      answerRequest: () => {
        throw new Error("proposals/wake-ids.md is not in her notebook.");
      },
    };
    expect(await run("!answer wake-ids Yes.", extra)).toBe("proposals/wake-ids.md is not in her notebook.");
  });

  it("records nothing itself, so answerProposal is the only writer", async () => {
    await write(WAKE, "# Wake ids\n");
    await run("!answer wake-ids Yes.", {
      answerRequest: () => undefined,
    });
    expect(rows).toEqual([]);
    expect(notebook.log.filter((entry) => entry.author === "summoner")).toEqual([]);
  });
});

describe("the new words and the help text", () => {
  it("reads !requests and !answer as body commands", () => {
    expect(isSummonerCommand("!requests")).toBe(true);
    expect(isSummonerCommand("!answer x y")).toBe(true);
    expect(isSummonerCommand("!Requests")).toBe(true);
  });

  it("carries both new help lines after the !approve line", () => {
    const lines = HELP_TEXT.split("\n");
    const approve = lines.findIndex((line) => line.startsWith("!approve"));
    expect(lines[approve + 1]).toBe(
      "!requests: list her requests to change her body (files under proposals/). !requests <file> shows one.",
    );
    expect(lines[approve + 2]).toBe("!answer <file> <text>: answer one of them. She is told, and it wakes her.");
  });

  it("leaves !proposals on the commitments, unchanged", async () => {
    await write(WAKE, "# Wake ids\n");
    expect(await run("!proposals")).toBe("No commitments are waiting for an answer.");
    proposals = [{ id: "abc12345", text: "I keep my promises.", why: "Because it matters.", atMs: NOW, thread: "cli:summoner" }];
    const listed = await run("!proposals");
    expect(listed).toContain("- abc12345: I keep my promises.");
    expect(listed).not.toContain("wake-ids");
  });
});
