import { describe, expect, it } from "vitest";
import { ModelError, NotebookError } from "../contracts.js";
import { MemoryNotebook } from "./memory-notebook.js";
import { ScriptedModel, call, reply, untilAborted } from "./scripted-model.js";

const AUTHOR = "thread:dm:owner";

async function expectNotebookError(promise: Promise<unknown>, kind: NotebookError["kind"]): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(NotebookError);
  expect((error as NotebookError).kind).toBe(kind);
}

describe("MemoryNotebook", () => {
  it("writes, reads back, and logs each change with its reason and author", async () => {
    const notebook = new MemoryNotebook({ nowMs: () => 42 });

    await notebook.write("people/mara.md", "Mara likes tea.\n", "first note", AUTHOR);

    expect(notebook.read("people/mara.md")).toBe("Mara likes tea.\n");
    expect(notebook.read("people/nobody.md")).toBeNull();
    expect(notebook.log).toEqual([{ op: "write", path: "people/mara.md", reason: "first note", author: AUTHOR, atMs: 42 }]);
  });

  it("edits exactly one occurrence, refuses a missing or repeated find", async () => {
    const notebook = new MemoryNotebook();
    await notebook.write("garden.md", "Beans in row one. Beans in row two.", "setup", AUTHOR);

    await expectNotebookError(notebook.edit("garden.md", "Beans", "Peas", "fix", AUTHOR), "ambiguous");
    await expectNotebookError(notebook.edit("garden.md", "Squash", "Pumpkin", "fix", AUTHOR), "not_found");
    await expectNotebookError(notebook.edit("missing.md", "a", "b", "fix", AUTHOR), "not_found");

    await notebook.edit("garden.md", "Beans in row one", "Peas in row one", "fix", AUTHOR);
    expect(notebook.read("garden.md")).toBe("Peas in row one. Beans in row two.");
  });

  it("appends, starting a new line when the note does not end with one", async () => {
    const notebook = new MemoryNotebook();

    await notebook.append("log.md", "first", "start", AUTHOR);
    await notebook.append("log.md", "second\n", "more", AUTHOR);
    await notebook.append("log.md", "third", "more", AUTHOR);

    expect(notebook.read("log.md")).toBe("first\nsecond\nthird");
  });

  it("moves a removed note to trash, recoverably, and keeps the trash out of list and search", async () => {
    const notebook = new MemoryNotebook();
    await notebook.write("old.md", "Retired plan.", "setup", AUTHOR);
    await notebook.write("old.md", "Second life.", "again", AUTHOR);

    await notebook.remove("old.md", "no longer needed", AUTHOR);
    await notebook.write("old.md", "New.", "new", AUTHOR);
    await notebook.remove("old.md", "again", AUTHOR);

    expect(notebook.read("old.md")).toBeNull();
    expect(notebook.read("trash/old.md")).toBe("Second life.");
    expect(notebook.read("trash/old.md.2")).toBe("New.");
    expect(notebook.list().map((e) => e.path)).toEqual([]);
    expect(notebook.search("life")).toEqual([]);
    await expectNotebookError(notebook.remove("old.md", "gone", AUTHOR), "not_found");
  });

  it("lists notes with bytes and first line, and can list one folder", async () => {
    const notebook = new MemoryNotebook();
    await notebook.write("people/mara.md", "\n  Mara\nlikes tea", "a", AUTHOR);
    await notebook.write("places/harbour.md", "The harbour.", "b", AUTHOR);
    await notebook.write("people-extra.md", "Not a person.", "c", AUTHOR);

    expect(notebook.list().map((e) => e.path)).toEqual(["people-extra.md", "people/mara.md", "places/harbour.md"]);
    expect(notebook.list("people/")).toEqual([
      { path: "people/mara.md", bytes: Buffer.byteLength("\n  Mara\nlikes tea", "utf8"), modifiedMs: expect.any(Number), firstLine: "Mara" },
    ]);
    expect(notebook.list("nowhere")).toEqual([]);
  });

  it("searches lines case-insensitively with 1-based line numbers, and respects the limit", async () => {
    const notebook = new MemoryNotebook();
    await notebook.write("people/mara.md", "Mara likes tea.\nShe lives by the Harbour.\nTea at dusk.", "a", AUTHOR);

    expect(notebook.search("TEA")).toEqual([
      { path: "people/mara.md", line: 1, text: "Mara likes tea." },
      { path: "people/mara.md", line: 3, text: "Tea at dusk." },
    ]);
    expect(notebook.search("tea", 1)).toHaveLength(1);
    expect(notebook.search("")).toEqual([]);
  });

  it("refuses paths that are absolute, climb out, or use backslashes", async () => {
    const notebook = new MemoryNotebook();

    await expectNotebookError(notebook.write("../secrets.md", "x", "r", AUTHOR), "bad_path");
    await expectNotebookError(notebook.write("/etc/passwd", "x", "r", AUTHOR), "bad_path");
    await expectNotebookError(notebook.write("C:/x.md", "x", "r", AUTHOR), "bad_path");
    await expectNotebookError(notebook.write("a\\b.md", "x", "r", AUTHOR), "bad_path");
    await expectNotebookError(notebook.write("a//b.md", "x", "r", AUTHOR), "bad_path");
    expect(() => notebook.read("")).toThrow(NotebookError);
    expect(notebook.log).toEqual([]);
  });
});

describe("ScriptedModel", () => {
  it("replays its steps in order and records each request as it was sent", async () => {
    const model = new ScriptedModel([reply({ content: "one" }), reply({ toolCalls: [call("end_turn", { note: "two" }, "c1")] })]);
    const messages = [{ role: "user" as const, content: "hello" }];

    const first = await model.complete({ messages });
    messages.push({ role: "user", content: "changed after the call" });
    const second = await model.complete({ messages, tools: [] });

    expect(first.content).toBe("one");
    expect(second.toolCalls[0]).toMatchObject({ id: "c1", name: "end_turn", arguments: '{"note":"two"}' });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(model.remaining).toBe(0);
  });

  it("throws a bad_request ModelError when the script runs out", async () => {
    const model = new ScriptedModel([]);

    await expect(model.complete({ messages: [] })).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("throws a step that is an error, and runs a step that is a function with the signal", async () => {
    const error = new ModelError("down", "unavailable", 2);
    const model = new ScriptedModel([error, untilAborted()]);
    await expect(model.complete({ messages: [] })).rejects.toBe(error);

    const controller = new AbortController();
    const pending = model.complete({ messages: [] }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("refuses at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new ScriptedModel([reply({ content: "never" })]);

    await expect(model.complete({ messages: [] }, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(model.remaining).toBe(1);
  });
});
