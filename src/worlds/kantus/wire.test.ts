import { describe, expect, it } from "vitest";
import {
  ACT_PREFIXES, BODY_LIMIT, capabilityPath, CAPABILITY_PATH_PATTERN, isActOp, isAnalyzeOp, isReadOp, KANTUS_PLACE, KANTUS_WORLD_ID,
  LARGE_BODY_LIMIT, MIN_TOKEN_BYTES, overviewPath, tokenProblem, tokensEqual, WireError,
} from "./wire.js";

/** Throws the WireError the studio would answer with, and returns its status and code. */
function refusal(fn: () => unknown): { status: number; code: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof WireError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error("expected a refusal");
}

const TOKEN = ["studio", "token", "0123456789abcdef", "more"].join("-");

describe("the Kantus wire's names and limits", () => {
  it("names one world and one place, and keeps 64 KiB for a usual body and 10 MB for evidence and a sync", () => {
    expect(KANTUS_WORLD_ID).toBe("kantus");
    expect(KANTUS_PLACE).toBe("kantus:studio");
    expect(BODY_LIMIT).toBe(64 * 1024);
    expect(LARGE_BODY_LIMIT).toBe(10 * 1024 * 1024);
  });
});

describe("the studio token", () => {
  it("compares tokens by their digests, so a difference anywhere is still a difference", () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(TOKEN, `${TOKEN}!`)).toBe(false);
    expect(tokensEqual("", TOKEN)).toBe(false);
    expect(MIN_TOKEN_BYTES).toBe(32);
  });

  it("names why a token may not be used: missing, too short, or equal to another the body holds", () => {
    expect(tokenProblem("   ", [])).toBe("missing");
    expect(tokenProblem("short", [])).toBe("too_short");
    expect(tokenProblem(TOKEN, [])).toBeNull();
    expect(tokenProblem(TOKEN, ["", TOKEN])).toBe("matches_other");
    expect(tokenProblem(TOKEN, ["another-token-that-is-long-enough-000000"])).toBeNull();
  });
});

describe("Capabilities paths", () => {
  it("keeps a relative markdown path, whatever its depth", () => {
    expect(capabilityPath("Craft/Groove_And_Pocket.md")).toBe("Craft/Groove_And_Pocket.md");
    expect(capabilityPath("Playbooks/Vocal_PodMic_Chain.md")).toBe("Playbooks/Vocal_PodMic_Chain.md");
    expect(capabilityPath("VST3/Acme_Audio/Tape_Echo/Overview.md")).toBe("VST3/Acme_Audio/Tape_Echo/Overview.md");
    expect(CAPABILITY_PATH_PATTERN.test("Craft/Groove_And_Pocket.md")).toBe(true);
  });

  it("drops the folder's own name when the caller says it, since Capabilities/ is where these live", () => {
    expect(capabilityPath("Capabilities/Content/INDEX.md")).toBe("Content/INDEX.md");
    expect(capabilityPath("Capabilities/Craft/Groove_And_Pocket.md")).toBe("Craft/Groove_And_Pocket.md");
    expect(overviewPath("Capabilities/VST3/Acme_Audio/Tape_Echo/Overview.md")).toBe("VST3/Acme_Audio/Tape_Echo/Overview.md");
  });

  it("refuses a path that leaves the folder, starts at the root, holds a NUL, or is not markdown", () => {
    expect(refusal(() => capabilityPath("../secrets.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft/../../other.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("/Craft/Groove.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft//Groove.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft/./Groove.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft/Groove.md\0"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft/Groove.txt"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft/Groove.MD"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Capabilities"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Capabilities/.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath(".md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath(""))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft/with space.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath("Craft\\Groove.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => capabilityPath(7))).toEqual({ status: 400, code: "bad_path" });
  });

  it("writes a summary only to VST3/<Vendor>/<Plugin>/Overview.md", () => {
    expect(overviewPath("VST3/Acme_Audio/Tape_Echo/Overview.md")).toBe("VST3/Acme_Audio/Tape_Echo/Overview.md");
    expect(refusal(() => overviewPath("VST3/Acme_Audio/Tape_Echo/Notes.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => overviewPath("VST3/Acme_Audio/Overview.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => overviewPath("Playbooks/Overview.md"))).toEqual({ status: 400, code: "bad_path" });
    expect(refusal(() => overviewPath("VST3/Acme_Audio/Tape_Echo/Overview.md/"))).toEqual({ status: 400, code: "bad_path" });
  });
});

describe("the studio's operations", () => {
  it("sorts every op into the group whose tool runs it", () => {
    for (const op of ["state.get", "state.summary", "session.arrangementSheet", "session.scoreSheet", "player.inspectRegion",
      "player.listStyles", "library.listPatches", "plugin.listCatalog", "plugin.listParams", "plugin.listPresets", "region.read",
      "midi.list", "chord.list", "marker.list", "comment.list", "automation.getTrackMode", "snapshot.list", "render.status",
      "arrange.getState", "tool.get"]) {
      expect([op, isReadOp(op)]).toEqual([op, true]);
    }
    for (const op of ["analysis.measure", "analysis.measureEdit", "analysis.evaluate", "analysis.lintScore", "analysis.masking",
      "analysis.renderEvidence", "ui.screenshot"]) {
      expect([op, isAnalyzeOp(op)]).toEqual([op, true]);
    }
    for (const op of ["batch.apply", "snapshot.capture", "player.play", "library.loadPatch", "compose.section", "midi.write",
      "track.setVolume", "clip.trim", "region.rename", "plugin.open", "mixer.setTrim", "automation.write", "transport.start",
      "cycle.set", "marker.add", "comment.add", "ui.highlight", "history.undo", "render.export", "project.save"]) {
      expect([op, isActOp(op)]).toEqual([op, true]);
    }
    expect(ACT_PREFIXES.every((prefix) => prefix.endsWith("."))).toBe(true);
    expect(isReadOp("transport.start")).toBe(false);
    expect(isActOp("state.get")).toBe(false);
    expect(isActOp("analysis.masking")).toBe(false);
    expect(isActOp("transport.")).toBe(false);
    expect(isActOp("unknown.op")).toBe(false);
  });
});
