import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantsPath, openGrants } from "../../entity/grants.js";
import { acquireLarLock, LAR_LOCK_BUSY_MESSAGE } from "../../entity/lar-lock.js";
import { MEDIA_FOLDER, openShelf } from "../../media/shelf.js";
import { openNotebook } from "../../notebook/index.js";
import { openRiver } from "../../river/index.js";
import { copyForReplay } from "../../replay/copy.js";
import { admitObservation, DOMUS_DB_FILE, DOMUS_FOLDER, openDomusDb } from "../../worlds/domus/store.js";
import { forgetCommand, parseForgetArgs, runForget } from "./forget.js";
import { runCommand } from "./run.js";

// Every name and line here is invented.
const REASON = "Owner asked to forget the lantern note";
/** The eight PNG signature bytes and a few more: enough for the shelf to keep a picture of this kind. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let root: string;
let dir: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "natalis-forgetcmd-"));
  dir = join(root, "iris");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entity.json"), "{}", "utf8");

  const river = openRiver(join(dir, "river.db"));
  river.append({ thread: "cli:owner", kind: "event", source: "owner", text: "Lantern Yard is by the water." });
  river.append({ thread: "cli:owner", kind: "event", source: "owner", text: "Hello there." });
  river.append({ thread: "cli:owner", kind: "say", source: "self", text: "Lantern yard again, then." });
  river.close();

  const notebook = await openNotebook(join(dir, "notebook"));
  await notebook.write("people/mara.md", "Mara lives on Lantern Yard\nShe likes tea\nlantern is near yard\n", "Note on Mara", "body");
  await notebook.write("places/quay.md", "Lantern yard is quiet\n", "Note on the quay", "body");
  await notebook.write("private/old.md", "Lantern Yard, an old note\n", "An old note", "body");
  await notebook.remove("private/old.md", "Move an old note away", "body");

  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The river row numbers of every row with this text, read back from the river. */
function seqsOf(text: string): number[] {
  const river = openRiver(join(dir, "river.db"));
  try {
    return river.read({ limit: 1000 }).filter((row) => row.text === text).map((row) => row.seq);
  } finally {
    river.close();
  }
}

function gitLog(): string {
  return execFileSync("git", ["log", "--format=%an|%s"], { cwd: join(dir, "notebook"), encoding: "utf8" });
}

describe("reading the forget flags", () => {
  it("needs a folder, a reason, and exactly one of --query or --seqs", () => {
    expect(parseForgetArgs(["--query", "x", "--reason", "r"])).toMatchObject({ ok: false, error: /--dir is missing/ });
    expect(parseForgetArgs(["--dir", dir, "--query", "x"])).toMatchObject({ ok: false, error: /--reason is missing/ });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r"])).toMatchObject({ ok: false, error: /Give either/ });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--query", "x", "--seqs", "1"])).toMatchObject({
      ok: false,
      error: /Give either/,
    });
  });

  it("needs a word to search for, and row numbers it can read", () => {
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--query", "  "])).toMatchObject({
      ok: false,
      error: /at least one word/,
    });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--seqs", "3,x"])).toMatchObject({
      ok: false,
      error: /row numbers such as 3,4,9/,
    });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--seqs", "0"])).toMatchObject({ ok: false });
  });

  it("reads a valid query or list of row numbers", () => {
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--query", "Lantern Yard"])).toEqual({
      ok: true,
      request: { dir, query: "Lantern Yard", reason: "r" },
    });
    expect(parseForgetArgs(["--dir", dir, "--reason", "r", "--seqs", "3, 4,9"])).toEqual({
      ok: true,
      request: { dir, seqs: [3, 4, 9], reason: "r" },
    });
  });
});

describe("natalis forget --query", () => {
  it("forgets the river rows and the note lines with the words, and prints counts only", async () => {
    const code = await forgetCommand(["--dir", dir, "--query", "lantern yard", "--reason", REASON], (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(0);
    expect(out[0]).toMatch(
      /^Forgot 2 river row\(s\), 3 note line\(s\) in 2 note file\(s\), 0 text\(s\) in the state file, 1 line\(s\) in trash\/, \d+ notebook commit\(s\) rewritten, 0 file\(s\) in the home, and 0 picture\(s\) on the shelf\.$/,
    );
    expect(out.join("\n")).toContain("stop it and run this again");
    expect(out.join("\n")).toContain("Older backups still hold the old text until they rotate out.");
    expect(out.join("\n")).not.toMatch(/lantern|mara|quay/i);
  });

  it("replaces the matching note lines, leaves the rest, and forgets the matching lines in trash too", async () => {
    await runForget({ dir, query: "lantern yard", reason: REASON });

    const notebook = await openNotebook(join(dir, "notebook"));
    expect(notebook.read("people/mara.md")).toBe("[forgotten by the summoner]\nShe likes tea\n[forgotten by the summoner]\n");
    expect(notebook.read("places/quay.md")).toBe("[forgotten by the summoner]\n");
    const trashed = notebook.list("trash").map((entry) => entry.path);
    expect(trashed).toHaveLength(1);
    expect(notebook.read(trashed[0] as string)).toBe("[forgotten by the summoner]\n");
  });

  it("leaves no hit for the words in the river, the notebook's history, trash, the home or the shelf", async () => {
    // Invented words, put in every place the Lar keeps text: a note, a note moved to trash, the home, and a picture's row.
    const notebook = await openNotebook(join(dir, "notebook"));
    await notebook.write("people/cat.md", "Marigold canary is the name of the cat.\n", "Note on the cat", "body");
    await notebook.remove("people/cat.md", "Move the cat note away", "body");
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "home", "notes.txt"), "Marigold canary, kept in the home.\n", "utf8");
    const shelf = openShelf(join(dir, MEDIA_FOLDER));
    const picture = shelf.keep({ bytes: PNG_BYTES, name: "marigold canary.png", from: { world: "cli", place: "cli:owner" }, atMs: 1_700_000_000_000 });
    const river = openRiver(join(dir, "river.db"));
    river.append({
      thread: "cli:owner",
      kind: "say",
      source: "self",
      text: `Marigold canary is in the picture.\n[picture ${picture.id}: marigold canary.png]`,
      data: { pictures: [picture.id] },
    });
    river.close();

    await runForget({ dir, query: "marigold canary", reason: REASON });

    const history = execFileSync("git", ["log", "-p", "--all"], { cwd: join(dir, "notebook"), encoding: "utf8" });
    expect(history).not.toMatch(/marigold canary/i);
    expect(history).toContain("[forgotten by the summoner]");
    for (const entry of notebook.list("trash")) expect(notebook.read(entry.path) ?? "").not.toMatch(/marigold canary/i);
    expect(existsSync(join(dir, "home", "notes.txt"))).toBe(false);
    expect(openShelf(join(dir, MEDIA_FOLDER)).list()).toEqual([]);
    const after = openRiver(join(dir, "river.db"));
    try {
      expect(JSON.stringify(after.read({ limit: 1000 }))).not.toMatch(/marigold canary/i);
    } finally {
      after.close();
    }
  });

  it("commits each changed file as the owner, with the reason", async () => {
    await runForget({ dir, query: "lantern yard", reason: REASON });
    const lines = gitLog().trim().split("\n");
    expect(lines.filter((line) => line === `owner|${REASON}`)).toHaveLength(2);
  });

  it("forgets nothing when no words match", async () => {
    await runForget({ dir, query: "nothing like this", reason: REASON });
    expect(seqsOf("Lantern Yard is by the water.")).toHaveLength(1);
    const notebook = await openNotebook(join(dir, "notebook"));
    expect(notebook.read("people/mara.md")).toContain("Mara lives on Lantern Yard");
  });

  it("forgetting a request's words clears its grant's hash and scope, logs it, and asks again", async () => {
    const grants = openGrants(dir);
    let requestId = 0;
    let grantId = 0;
    let hash = "";
    try {
      const river = openRiver(join(dir, "river.db"));
      let seq = 0;
      try {
        seq = river.append({
          thread: "cli:owner",
          place: "cli:owner",
          kind: "say",
          source: "body",
          text: "[natalis] Iris asks to use web_request on forum.example.org: POST forum.example.org/lantern-yard.",
          data: { permissionRequest: true, tool: "web_request", scope: "forum.example.org" },
        }).seq;
      } finally {
        river.close();
      }
      hash = grants.hmac({ url: "https://forum.example.org/lantern-yard" });
      requestId = grants.request({
        tool: "web_request",
        scopeKey: "forum.example.org",
        argsHmac: hash,
        postedSeq: seq,
        place: "cli:owner",
        askingThread: "cli:owner",
        nowMs: Date.now(),
      });
      grantId = grants.addGrant({
        tool: "web_request",
        scope: "forum.example.org",
        kind: "once",
        requestSeq: requestId,
        argsHmac: hash,
        createdBy: "owner",
        nowMs: Date.now(),
      });
    } finally {
      grants.close();
    }

    await runForget({ dir, query: "lantern yard", reason: REASON });

    const after = openGrants(dir);
    try {
      expect(after.getRequest(requestId)).toMatchObject({ scopeKey: "cleared", argsHmac: "", status: "cleared" });
      const grant = after.listGrants().find((item) => item.id === grantId);
      expect(grant?.scope).toBe("cleared");
      expect(grant?.argsHmac).toBeUndefined();
      expect(after.check({ tool: "web_request", scope: "forum.example.org", argsHmac: hash, nowMs: Date.now() })).toEqual({
        outcome: "ask",
      });
    } finally {
      after.close();
    }
    const db = new DatabaseSync(grantsPath(dir));
    try {
      expect(db.prepare("SELECT grant_id, event FROM grant_log WHERE event = 'cleared by forget'").all()).toEqual([
        { grant_id: grantId, event: "cleared by forget" },
      ]);
    } finally {
      db.close();
    }
    expect(readFileSync(grantsPath(dir)).includes(Buffer.from("lantern"))).toBe(false);
  });

  it("forgetting a request row by number clears its grant too", async () => {
    const river = openRiver(join(dir, "river.db"));
    let requestSeq = 0;
    try {
      requestSeq = river.append({
        thread: "cli:owner",
        place: "cli:owner",
        kind: "say",
        source: "body",
        text: "[natalis] Iris asks to use web_request on example.net: GET example.net/harbour.",
        data: { permissionRequest: true, tool: "web_request", scope: "example.net" },
      }).seq;
    } finally {
      river.close();
    }
    const grants = openGrants(dir);
    let requestId = 0;
    let grantId = 0;
    const hash = grants.hmac({ url: "https://example.net/harbour" });
    try {
      requestId = grants.request({
        tool: "web_request",
        scopeKey: "example.net",
        argsHmac: hash,
        postedSeq: requestSeq,
        place: "cli:owner",
        askingThread: "cli:owner",
        nowMs: Date.now(),
      });
      grantId = grants.addGrant({
        tool: "web_request",
        scope: "example.net",
        kind: "once",
        requestSeq: requestId,
        argsHmac: hash,
        createdBy: "owner",
        nowMs: Date.now(),
      });
    } finally {
      grants.close();
    }

    await runForget({ dir, seqs: [requestSeq], reason: REASON });

    const after = openGrants(dir);
    try {
      expect(after.getRequest(requestId)?.status).toBe("cleared");
      expect(after.listGrants().find((item) => item.id === grantId)?.scope).toBe("cleared");
      expect(after.check({ tool: "web_request", scope: "example.net", argsHmac: hash, nowMs: Date.now() })).toEqual({
        outcome: "ask",
      });
    } finally {
      after.close();
    }
  });
});

describe("natalis forget --query and the game store", () => {
  it("also forgets the words in the game store when there is one, and counts its rows", async () => {
    const game = openDomusDb(dir);
    admitObservation(game, {
      observationId: "helper-1.1", digest: "d", thread: "domus:slot3", world: "slot3", branch: "b", session: "s", attachment: "helper-1",
      body: "sim-9", snapshot: "7", seq: 1, sourceTimeMs: 1_800_000_000_000, expiresAtMs: 1_800_000_030_000, receiptTimeMs: 1_800_000_000_000,
      lineageClass: "LIVE", payloadJson: JSON.stringify({ options: [{ object: "Lantern Yard door", acts: [] }] }),
    });
    game.close();
    const code = await forgetCommand(["--dir", dir, "--query", "lantern yard", "--reason", REASON], (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(0);
    expect(out[0]).toMatch(
      /^Forgot 2 river row\(s\), 3 note line\(s\) in 2 note file\(s\), 0 text\(s\) in the state file, 1 line\(s\) in trash\/, \d+ notebook commit\(s\) rewritten, 0 file\(s\) in the home, and 0 picture\(s\) on the shelf, and 1 row\(s\) in the game's store\.$/,
    );
    expect(out).toContain("The game's own lists may show the words again: they are the game's, not the Lar's.");
    const check = new DatabaseSync(join(dir, DOMUS_FOLDER, DOMUS_DB_FILE));
    try {
      expect(check.prepare("SELECT payload_json FROM observations").get()).toEqual({ payload_json: "{}" });
    } finally {
      check.close();
    }
    expect(out.join("\n")).not.toMatch(/lantern|yard|door/i);
  });
});

describe("natalis forget --seqs", () => {
  it("forgets the river rows by number and leaves the notebook alone", async () => {
    const [hello] = seqsOf("Hello there.");
    const code = await forgetCommand(["--dir", dir, "--seqs", String(hello), "--reason", REASON], (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(0);
    expect(out).toEqual([`Forgot 1 river row(s).`]);
    expect(seqsOf("Hello there.")).toEqual([]);
    expect(seqsOf("Lantern Yard is by the water.")).toHaveLength(1);
  });
});

describe("refusing a forget it cannot do", () => {
  it("refuses a folder that is not an entity's", async () => {
    await expect(runForget({ dir: join(root, "elsewhere"), query: "x", reason: REASON })).rejects.toThrow(/No entity.json/);
  });

  it("prints the usage and exits 2 when the flags are wrong", async () => {
    const code = await forgetCommand(["--dir", dir], (l) => out.push(l), (l) => err.push(l));
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("Usage: natalis forget");
    expect(out).toEqual([]);
  });
});

describe("natalis forget and the Lar folder lock", () => {
  it("refuses while another holder has the lock, and forgets nothing", async () => {
    const lock = acquireLarLock(dir);
    try {
      const code = await forgetCommand(["--dir", dir, "--query", "lantern yard", "--reason", REASON], (l) => out.push(l), (l) => err.push(l));
      expect(code).toBe(1);
      expect(err).toEqual([LAR_LOCK_BUSY_MESSAGE]);
      expect(out).toEqual([]);
      expect(seqsOf("Lantern Yard is by the water.")).toHaveLength(1);
    } finally {
      lock.release();
    }
  });

  it("holds the lock for the whole forget, so natalis run is refused meanwhile", async () => {
    writeFileSync(
      join(dir, "entity.json"),
      JSON.stringify({
        model: { baseUrl: "https://model.example.invalid/v1", model: "test-model", contextTokens: 1000 },
        summoner: { alias: "Mara" },
      }),
      "utf8",
    );
    const forgetting = runForget({ dir, query: "lantern yard", reason: REASON });
    const runErr: string[] = [];
    // runForget takes the lock before its first await, so this run sees it held by the forget.
    const code = await runCommand(["--dir", dir], () => {}, (line) => runErr.push(line));
    expect(code).toBe(1);
    expect(runErr).toEqual([LAR_LOCK_BUSY_MESSAGE]);
    await forgetting;
    // The forget released the lock when it ended.
    acquireLarLock(dir).release();
  });
});

describe("natalis forget, note file names and copies", () => {
  it("a note whose file name holds the words is renamed and its links repaired", async () => {
    const notebook = await openNotebook(join(dir, "notebook"));
    await notebook.write("people/mara.md", "She keeps the quay.\n", "A note on her", "body");
    await notebook.write("people/index.md", "See [her note](people/mara.md).\n", "An index", "body");

    const counts = await runForget({ dir, query: "mara vale", reason: REASON });

    expect(counts.renamed).toBe(1);
    expect(counts.linkFiles).toBe(1);
    expect(notebook.read("people/mara.md")).toBeNull();
    expect(notebook.read("people/forgotten.md")).toBe("She keeps the quay.\n");
    expect(notebook.read("people/index.md")).toBe("See [her note](people/forgotten.md).\n");
    expect(notebook.list().map((entry) => entry.path).join("\n")).not.toMatch(/mara/i);
    expect(existsSync(join(dir, "notebook", "people", "mara.md"))).toBe(false);
  });

  it("a note whose file name holds only one of the words keeps the other words out of links", async () => {
    const notebook = await openNotebook(join(dir, "notebook"));
    await notebook.write("people/mara.md", "She keeps the quay.\n", "A note on her", "body");
    await notebook.write("people/index.md", "See [her note](people/mara.md) by the lamp.\n", "An index", "body");

    await runForget({ dir, query: "mara vale", reason: REASON });

    expect(notebook.read("people/index.md")).toBe("See [her note](people/forgotten.md) by the lamp.\n");
  });

  it("replay and eval copies under the Lar folder are purged", async () => {
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ lastSeq: 2, threads: {}, asks: [], wakes: [], mood: null }),
      "utf8",
    );
    const river = openRiver(join(dir, "river.db"));
    river.append({ thread: "cli:owner", kind: "event", source: "owner", text: "Mara Vale was here." });
    river.close();

    const replayRun = join(dir, "runs", "replay-1");
    await copyForReplay({ from: dir, to: join(replayRun, "entity"), cutAtMs: 0 });
    writeFileSync(join(replayRun, "transcript.jsonl"), "{}\n", "utf8");

    const evalRun = join(dir, "runs", "eval-1");
    mkdirSync(join(evalRun, "cases"), { recursive: true });
    writeFileSync(join(evalRun, "summary.json"), JSON.stringify({ note: "Mara Vale" }), "utf8");
    writeFileSync(join(evalRun, "results.jsonl"), "", "utf8");
    writeFileSync(join(evalRun, "cases", "1.json"), JSON.stringify({ text: "Mara Vale" }), "utf8");

    // A backup is not a copy: it ages out as today and is never purged by a forget.
    const backup = join(dir, "backups", "old");
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "MANIFEST.json"), "{}", "utf8");
    copyFileSync(join(dir, "river.db"), join(backup, "river.db"));

    const counts = await runForget({ dir, query: "mara vale", reason: REASON });

    expect(counts.copies).toBe(2);
    expect(existsSync(replayRun)).toBe(false);
    expect(existsSync(evalRun)).toBe(false);
    expect(existsSync(join(backup, "MANIFEST.json"))).toBe(true);
    expect(existsSync(join(backup, "river.db"))).toBe(true);
  });
});
