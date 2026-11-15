import { describe, expect, it } from "vitest";
import { bodyChangesNote, parseBodyChanges, type BodyChanges } from "./body-changes.js";

function commit(hash: string, parents: string[], subject: string) {
  return { hash, parents, subject };
}

function changesOf(commits: BodyChanges["commits"], head = commits[0]?.hash ?? ""): BodyChanges {
  return { head, commits };
}

describe("parseBodyChanges", () => {
  it("reads the build's shape", () => {
    const parsed = parseBodyChanges({
      version: 1,
      head: "c",
      commits: [
        { hash: "c", parents: ["b"], subject: "Third" },
        { hash: "b", parents: [], subject: "Second" },
      ],
    });

    expect(parsed).toEqual({
      head: "c",
      commits: [
        { hash: "c", parents: ["b"], subject: "Third" },
        { hash: "b", parents: [], subject: "Second" },
      ],
    });
  });

  it("is undefined when the shape is wrong", () => {
    expect(parseBodyChanges(null)).toBeUndefined();
    expect(parseBodyChanges({ version: 2, head: "c", commits: [] })).toBeUndefined();
    expect(parseBodyChanges({ version: 1, head: 4, commits: [] })).toBeUndefined();
    expect(parseBodyChanges({ version: 1, head: "c", commits: [{ hash: "c", parents: [1], subject: "x" }] })).toBeUndefined();
    expect(parseBodyChanges({ version: 1, head: "c", commits: [{ hash: "c", parents: [], subject: 7 }] })).toBeUndefined();
  });
});

describe("bodyChangesNote", () => {
  it("says nothing when the head is the one she last ran", () => {
    const changes = changesOf([commit("c", ["b"], "Third"), commit("b", [], "Second")]);
    expect(bodyChangesNote(changes, "c")).toBeUndefined();
  });

  it("says more than 500 changes when the commit she ran is not in the list", () => {
    const changes = changesOf([commit("c", ["b"], "Third"), commit("b", [], "Second")]);
    expect(bodyChangesNote(changes, "gone")).toBe(
      "Your body changed since your last start: more than 500 changes.",
    );
  });

  it("counts a merged branch's commits as new, even when the list puts them after her last commit", () => {
    const changes = changesOf([
      commit("m", ["n", "b"], "Merge the branch"),
      commit("n", ["s"], "Main change"),
      commit("s", ["o"], "Her last start"),
      commit("b", ["o"], "Branch change"),
      commit("o", [], "Older"),
    ]);
    expect(bodyChangesNote(changes, "s")).toBe(
      "Your body changed since your last start (2 changes): Main change; Branch change.",
    );
  });

  it("leaves out merges and subjects that start with test( or chore", () => {
    const changes = changesOf([
      commit("e", ["d"], "A real change"),
      commit("d", ["s"], "chore: tidy the build"),
      commit("c", ["s"], "test(the wake path)"),
      commit("b", ["s", "x"], "Merge a branch"),
      commit("s", [], "Her last start"),
    ]);
    expect(bodyChangesNote(changes, "s")).toBe(
      "Your body changed since your last start (1 changes): A real change.",
    );
  });

  it("names the newest thirty and gives the total when more than thirty are shown", () => {
    const commits = [commit("s", [], "Her last start")];
    for (let n = 1; n <= 31; n += 1) {
      commits.unshift(commit(`n${n}`, [n === 1 ? "s" : `n${n - 1}`], `Change ${n}`));
    }
    const note = bodyChangesNote(changesOf(commits), "s") ?? "";
    expect(note).toMatch(/^Your body changed since your last start \(31 changes; the newest 30 here\): /);
    expect(note).toContain("Change 31");
    expect(note).toContain("Change 2");
    expect(note).not.toContain("Change 1;");
  });

  it("says nothing when every new commit is hidden", () => {
    const changes = changesOf([
      commit("c", ["s"], "chore: tidy"),
      commit("b", ["s"], "test(a path)"),
      commit("m", ["s", "x"], "Merge a branch"),
      commit("s", [], "Her last start"),
    ]);
    expect(bodyChangesNote(changes, "s")).toBeUndefined();
  });
});
