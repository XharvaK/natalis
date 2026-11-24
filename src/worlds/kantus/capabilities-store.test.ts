import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capabilitiesRoot, MAX_READ_LINES, openCapabilities, OVERVIEW_BYTES_MAX,
} from "./capabilities-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-kantus-caps-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const GROOVE = ["# Groove", "", "Ghost notes sit low.", "The backbeat sits high."].join("\n");
const MASKING = ["# Masking", "", "Kick and bass share 60 to 110 Hz.", "Vocals and keys share 180 to 350 Hz."].join("\n");

describe("the Capabilities folder", () => {
  it("lives at kantus/capabilities in the Lar's folder", () => {
    expect(capabilitiesRoot(dir)).toBe(join(dir, "kantus", "capabilities"));
    expect(openCapabilities(dir).root).toBe(capabilitiesRoot(dir));
  });

  it("writes an initial sync, updates one sheet, and leaves the others alone", () => {
    const store = openCapabilities(dir);
    expect(store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: GROOVE }, { path: "Playbooks/Masking_Diagnosis.md", text: MASKING }]))
      .toEqual({ written: 2, removed: 0 });
    expect(readFileSync(join(dir, "kantus", "capabilities", "Craft", "Groove_And_Pocket.md"), "utf8")).toBe(GROOVE);

    expect(store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: "# Groove, revised" }])).toEqual({ written: 1, removed: 0 });
    expect(readFileSync(join(dir, "kantus", "capabilities", "Craft", "Groove_And_Pocket.md"), "utf8")).toBe("# Groove, revised");
    expect(readFileSync(join(dir, "kantus", "capabilities", "Playbooks", "Masking_Diagnosis.md"), "utf8")).toBe(MASKING);
  });

  it("removes the sheets a full sync no longer lists, and only in a full sync", () => {
    const store = openCapabilities(dir);
    store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: GROOVE }, { path: "Playbooks/Vocal_PodMic_Chain.md", text: MASKING }]);

    expect(store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: GROOVE }])).toEqual({ written: 1, removed: 0 });
    expect(store.read("Playbooks/Vocal_PodMic_Chain.md").ok).toBe(true);

    expect(store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: GROOVE }], { full: true })).toEqual({ written: 1, removed: 1 });
    expect(store.read("Playbooks/Vocal_PodMic_Chain.md")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses a sheet that would leave the folder, holds no text, or is listed twice", () => {
    const store = openCapabilities(dir);
    expect(() => store.applySync([{ path: "../escape.md", text: "x" }])).toThrow(/bad_path/);
    expect(() => store.applySync([{ path: "Craft/Groove.md", text: 7 } as never])).toThrow(/no text/);
    expect(() => store.applySync([
      { path: "Craft/Groove.md", text: "one" },
      { path: "Craft/Groove.md", text: "two" },
    ])).toThrow(/duplicate_path/);
    // Nothing was written: the bad sync changed no sheet at all.
    expect(store.read("Craft/Groove.md")).toMatchObject({ ok: false, code: "not_synced" });
  });
});

describe("reading a sheet", () => {
  it("returns numbered lines from the start, and says where the next block starts", () => {
    const store = openCapabilities(dir);
    store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: GROOVE }]);

    expect(store.read("Craft/Groove_And_Pocket.md")).toEqual({
      ok: true, path: "Craft/Groove_And_Pocket.md", totalLines: 4, fromLine: 1,
      lines: [{ line: 1, text: "# Groove" }, { line: 2, text: "" }, { line: 3, text: "Ghost notes sit low." }, { line: 4, text: "The backbeat sits high." }],
    });
    expect(store.read("Craft/Groove_And_Pocket.md", { offsetLine: 3, maxLines: 1 })).toMatchObject({
      ok: true, fromLine: 3, lines: [{ line: 3, text: "Ghost notes sit low." }], nextLine: 4,
    });
  });

  it("caps a read at 250 lines, whatever is asked for", () => {
    const long = Array.from({ length: 4000 }, (_, index) => `line ${index + 1}`).join("\n");
    const store = openCapabilities(dir);
    store.applySync([{ path: "VST3/Acme_Audio/Tape_Echo/PARAMETERS_FULL.md", text: long }]);

    const read = store.read("VST3/Acme_Audio/Tape_Echo/PARAMETERS_FULL.md", { maxLines: 10_000 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.lines).toHaveLength(MAX_READ_LINES);
    expect(read.lines[0]).toEqual({ line: 1, text: "line 1" });
    expect(read.lines[249]).toEqual({ line: 250, text: "line 250" });
    expect(read.nextLine).toBe(251);
    expect(read.totalLines).toBe(4000);
  });

  it("finds the lines a query matches, without case, and counts them all", () => {
    const store = openCapabilities(dir);
    store.applySync([{ path: "Playbooks/Masking_Diagnosis.md", text: MASKING }]);

    const read = store.read("Playbooks/Masking_Diagnosis.md", { query: "hz" });
    expect(read).toMatchObject({ ok: true, matched: 2, lines: [{ line: 3, text: "Kick and bass share 60 to 110 Hz." }, { line: 4, text: "Vocals and keys share 180 to 350 Hz." }] });
    expect(store.read("Playbooks/Masking_Diagnosis.md", { query: "hz", maxLines: 1 })).toMatchObject({ matched: 2, lines: [{ line: 3, text: "Kick and bass share 60 to 110 Hz." }] });
    expect(store.read("Playbooks/Masking_Diagnosis.md", { query: "nothing here" })).toMatchObject({ ok: true, matched: 0, lines: [] });
  });

  it("refuses a query with an offset, a bad offset or size, a path outside the folder, and a sheet that is not there", () => {
    const store = openCapabilities(dir);
    store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: GROOVE }]);

    expect(store.read("Craft/Groove_And_Pocket.md", { query: "beat", offsetLine: 2 })).toMatchObject({ ok: false, code: "bad_args" });
    expect(store.read("Craft/Groove_And_Pocket.md", { offsetLine: 0 })).toMatchObject({ ok: false, code: "bad_args" });
    expect(store.read("Craft/Groove_And_Pocket.md", { maxLines: 0 })).toMatchObject({ ok: false, code: "bad_args" });
    expect(store.read("../entity.json")).toMatchObject({ ok: false, code: "bad_path" });
    expect(store.read("Craft/Not_There.md")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("says so plainly when no sync has reached this host yet", () => {
    expect(openCapabilities(dir).read("Craft/Groove_And_Pocket.md")).toMatchObject({ ok: false, code: "not_synced" });
  });

  it("starts past the end with no lines and nothing more to ask for", () => {
    const store = openCapabilities(dir);
    store.applySync([{ path: "Craft/Groove_And_Pocket.md", text: GROOVE }]);
    expect(store.read("Craft/Groove_And_Pocket.md", { offsetLine: 99 })).toEqual({
      ok: true, path: "Craft/Groove_And_Pocket.md", totalLines: 4, fromLine: 99, lines: [],
    });
  });
});

describe("writing an overview", () => {
  it("writes VST3/<Vendor>/<Plugin>/Overview.md and nothing else", () => {
    const store = openCapabilities(dir);
    const overview = "# Tape Echo\n\nA bright, worn echo.";
    expect(store.writeOverview("VST3/Acme_Audio/Tape_Echo/Overview.md", overview)).toEqual({
      ok: true, path: "VST3/Acme_Audio/Tape_Echo/Overview.md", bytes: Buffer.byteLength(overview, "utf8"),
    });
    expect(readFileSync(join(dir, "kantus", "capabilities", "VST3", "Acme_Audio", "Tape_Echo", "Overview.md"), "utf8"))
      .toBe(overview);

    mkdirSync(join(dir, "kantus", "capabilities", "Playbooks"), { recursive: true });
    writeFileSync(join(dir, "kantus", "capabilities", "Playbooks", "Masking_Diagnosis.md"), MASKING);
    expect(store.writeOverview("Playbooks/Masking_Diagnosis.md", "not an overview")).toMatchObject({ ok: false, code: "bad_path" });
    expect(readFileSync(join(dir, "kantus", "capabilities", "Playbooks", "Masking_Diagnosis.md"), "utf8")).toBe(MASKING);
  });

  it("refuses an empty overview, a path outside the shape, and one over 32 KiB", () => {
    const store = openCapabilities(dir);
    expect(store.writeOverview("VST3/Acme_Audio/Tape_Echo/Overview.md", "   ")).toMatchObject({ ok: false, code: "bad_text" });
    expect(store.writeOverview("VST3/Acme_Audio/Tape_Echo/Notes.md", "x")).toMatchObject({ ok: false, code: "bad_path" });
    expect(store.writeOverview("../Overview.md", "x")).toMatchObject({ ok: false, code: "bad_path" });

    const big = "x".repeat(OVERVIEW_BYTES_MAX + 1);
    expect(store.writeOverview("VST3/Acme_Audio/Tape_Echo/Overview.md", big)).toMatchObject({ ok: false, code: "too_large" });
    expect(OVERVIEW_BYTES_MAX).toBe(32 * 1024);
  });
});
