import { describe, expect, it } from "vitest";
import { ModelError, type ChatMessage, type Receipt, type RiverRow, type Tool } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { ScriptedModel, call, reply, untilAborted, type ScriptStep } from "../testing/scripted-model.js";
import { notebookTools } from "../tools/notebook-tools.js";
import { END_TURN, runTurn, runTurnWithMessages, type RunTurnInput } from "./run-turn.js";

const THREAD = "dm:owner";
const CLOCK_MS = Date.UTC(2026, 9, 11, 11, 5);
const ROOMY = { maxModelCalls: 10, maxToolCalls: 20 };

type Setup = Partial<Omit<RunTurnInput, "model" | "river" | "notebook">> & { steps: ScriptStep[] };

async function setup({ steps, ...overrides }: Setup) {
  const model = new ScriptedModel(steps);
  const river = new MemoryRiver({ nowMs: () => CLOCK_MS });
  const notebook = new MemoryNotebook({ nowMs: () => CLOCK_MS });
  await notebook.write("people/mara.md", "Mara likes tea.\nShe lives by the harbour.", "fixture", "test");
  const input: RunTurnInput = {
    model,
    tools: notebookTools(),
    system: "You are Iris, a test entity.",
    history: [],
    event: "Owner: what do you remember about Mara?",
    thread: THREAD,
    river,
    notebook,
    ceiling: ROOMY,
    nowMs: () => CLOCK_MS,
    turnId: "turn-1",
    ...overrides,
  };
  return { input, model, river, notebook };
}

function rowsOf(river: MemoryRiver): RiverRow[] {
  return river.read({ thread: THREAD });
}

function toolMessages(messages: ChatMessage[]): Array<{ toolCallId: string; content: string }> {
  return messages.flatMap((m) => (m.role === "tool" ? [{ toolCallId: m.toolCallId, content: m.content }] : []));
}

const boomTool: Tool = {
  spec: { name: "boom", description: "Always fails.", parameters: { type: "object", properties: {} } },
  async run(): Promise<Receipt> {
    throw new Error("boom");
  },
};

describe("runTurn: the two-turn tool loop", () => {
  it("reads a note, then ends the turn, with receipts and the model's view of them", async () => {
    const { input, model, river } = await setup({
      steps: [
        reply({ toolCalls: [call("read_note", { path: "people/mara.md" }, "c1")] }),
        reply({ toolCalls: [call(END_TURN, { note: "Mara is noted." }, "c2")] }),
      ],
      effort: "high",
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.modelCalls).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.receipts.map((r) => r.tool)).toEqual(["read_note", END_TURN]);
    expect(result.receipts[0]?.receipt.ok).toBe(true);
    expect(result.receipts[0]?.receipt.data?.["text"]).toContain("Mara likes tea.");
    expect(result.receipts[1]?.receipt.ok).toBe(true);
    expect(result.error).toBeUndefined();

    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]?.toolChoice).toBe("auto");
    expect(model.requests[0]?.effort).toBe("high");
    expect(model.requests[0]?.tools?.map((t) => t.name)).toEqual(["read_note", "write_note", "edit_note", "append_note", "list_notes", "trash_note", "recall", "forget", END_TURN]);
    const second = model.requests[1]?.messages ?? [];
    const tools = toolMessages(second);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolCallId).toBe("c1");
    expect(JSON.parse(tools[0]?.content ?? "{}")).toMatchObject({ ok: true });

    expect(rowsOf(river).filter((r) => r.kind === "tool_call").map((r) => r.text)).toEqual(["read_note", END_TURN]);
  });

  it("ends with no_tool_call when the model answers in words only, and keeps the words as thoughts", async () => {
    const { input, river } = await setup({ steps: [reply({ content: "Nothing to do here." })] });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("no_tool_call");
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.thoughts).toEqual(["Nothing to do here."]);
    expect(rowsOf(river).find((r) => r.kind === "note")).toMatchObject({
      source: "self",
      text: "Nothing to do here.",
      data: { thought: true, turnId: "turn-1" },
    });
  });

  it("records thoughts that come with tool calls, and ignores blank content", async () => {
    const { input } = await setup({
      steps: [
        reply({ content: "   ", toolCalls: [call("read_note", { path: "people/mara.md" }, "c1")] }),
        reply({ content: "Mara is in the notes.", toolCalls: [call(END_TURN, {}, "c2")] }),
      ],
    });

    const result = await runTurn(input);

    expect(result.thoughts).toEqual(["Mara is in the notes."]);
  });

  it("writes every river row in order: start, thought, call, receipt, call, receipt, end", async () => {
    const { input, river } = await setup({
      steps: [
        reply({ content: "Let me look.", toolCalls: [call("read_note", { path: "people/mara.md" }, "c1")] }),
        reply({ toolCalls: [call(END_TURN, {}, "c2")] }),
      ],
    });

    await runTurn(input);
    const rows = rowsOf(river);

    expect(rows.map((r) => r.kind)).toEqual(["turn", "note", "tool_call", "receipt", "tool_call", "receipt", "turn"]);
    expect(rows.map((r) => r.source)).toEqual(["body", "self", "self", "body", "self", "body", "body"]);
    expect(rows[0]?.data).toEqual({ phase: "start", turnId: "turn-1" });
    expect(rows[2]).toMatchObject({ text: "read_note", data: { args: JSON.stringify({ path: "people/mara.md" }), turnId: "turn-1", callId: "c1" } });
    expect(rows[3]).toMatchObject({ text: "Read people/mara.md.", data: { tool: "read_note", ok: true, turnId: "turn-1", callId: "c1" } });
    expect(rows[6]?.data).toEqual({ phase: "end", endedBy: "end_turn", turnId: "turn-1", modelCalls: 2, toolCalls: 2 });
    expect(rows.every((r) => r.thread === THREAD && r.atMs === CLOCK_MS)).toBe(true);
  });

  it("returns the whole message list: system, history, the event, then what the model produced", async () => {
    const { input } = await setup({
      steps: [
        reply({ toolCalls: [call("read_note", { path: "people/mara.md" }, "c1")] }),
        reply({ toolCalls: [call(END_TURN, {}, "c2")] }),
      ],
      history: [
        { role: "user", content: "Earlier: hello." },
        { role: "assistant", content: "Hello." },
      ],
    });

    const { result, messages } = await runTurnWithMessages(input);

    expect(result.endedBy).toBe("end_turn");
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "tool", "assistant", "tool"]);
    expect(messages[0]).toEqual({ role: "system", content: "You are Iris, a test entity." });
    expect(messages[3]).toEqual({ role: "user", content: "Owner: what do you remember about Mara?" });
    expect(messages[4]).toMatchObject({ role: "assistant", toolCalls: [{ id: "c1", name: "read_note" }] });
  });
});

describe("runTurn: refused and broken calls", () => {
  it("refuses arguments that are not JSON and lets the model try again", async () => {
    const { input, river } = await setup({
      steps: [
        reply({ toolCalls: [call("read_note", "{not json", "c1")] }),
        reply({ toolCalls: [call(END_TURN, {}, "c2")] }),
      ],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.receipts[0]?.receipt).toMatchObject({
      ok: false,
      summary: "Your arguments were not valid JSON.",
      refused: { code: "bad_arguments" },
    });
    expect(rowsOf(river).find((r) => r.kind === "receipt")).toMatchObject({
      text: "Your arguments were not valid JSON.",
      data: { tool: "read_note", ok: false, refused: { code: "bad_arguments" } },
    });
  });

  it("refuses arguments that are JSON but not an object", async () => {
    const { input } = await setup({
      steps: [reply({ toolCalls: [call("read_note", "[1, 2]", "c1")] }), reply({ toolCalls: [call(END_TURN, {}, "c2")] })],
    });

    const result = await runTurn(input);

    expect(result.receipts[0]?.receipt).toMatchObject({
      ok: false,
      summary: "Your arguments must be a JSON object.",
      refused: { code: "bad_arguments" },
    });
  });

  it("reads empty arguments as an empty object", async () => {
    const { input } = await setup({ steps: [reply({ toolCalls: [call(END_TURN, "", "c1")] })] });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.receipts[0]?.receipt.ok).toBe(true);
  });

  it("refuses a tool name that does not exist and names the tools that do", async () => {
    const { input } = await setup({
      steps: [reply({ toolCalls: [call("launch_rocket", {}, "c1")] }), reply({ toolCalls: [call(END_TURN, {}, "c2")] })],
    });

    const result = await runTurn(input);

    expect(result.receipts[0]?.receipt).toMatchObject({
      ok: false,
      summary: "There is no tool called launch_rocket.",
      refused: { code: "unknown_tool" },
    });
    expect(result.receipts[0]?.receipt.refused?.reason).toContain("read_note");
    expect(result.receipts[0]?.receipt.refused?.reason).toContain(END_TURN);
  });

  it("turns a thrown tool error into a receipt instead of ending the turn", async () => {
    const { input } = await setup({
      steps: [reply({ toolCalls: [call("boom", {}, "c1")] }), reply({ toolCalls: [call(END_TURN, {}, "c2")] })],
      tools: [boomTool],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.receipts[0]?.receipt).toEqual({
      ok: false,
      summary: "The tool failed: boom",
      refused: { code: "tool_error", reason: "boom" },
    });
  });

  it("does not end the turn when end_turn is refused; the model can end it again", async () => {
    const { input } = await setup({
      steps: [
        reply({ toolCalls: [call(END_TURN, { note: 5 }, "c1")] }),
        reply({ toolCalls: [call(END_TURN, {}, "c2")] }),
      ],
    });

    const result = await runTurn(input);

    expect(result.modelCalls).toBe(2);
    expect(result.receipts[0]?.receipt.ok).toBe(false);
    expect(result.endedBy).toBe("end_turn");
  });

  it("refuses a tool name the loop reserves", async () => {
    const { input } = await setup({
      steps: [reply({ content: "x" })],
      tools: [{ spec: { name: END_TURN, description: "x", parameters: {} }, run: async () => ({ ok: true, summary: "x" }) }],
    });

    await expect(runTurn(input)).rejects.toThrow(/belongs to the loop/);
  });
});

describe("runTurn: running several calls in one reply", () => {
  it("runs the rest of a reply after end_turn", async () => {
    const { input } = await setup({
      steps: [
        reply({
          toolCalls: [call(END_TURN, {}, "c1"), call("read_note", { path: "people/mara.md" }, "c2")],
        }),
      ],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(2);
    expect(result.receipts.map((r) => r.tool)).toEqual([END_TURN, "read_note"]);
  });
});

describe("runTurn: the ceiling", () => {
  it("stops after the model-call ceiling, with a note in the river", async () => {
    const readAgain = () => reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] });
    const { input, model, river } = await setup({
      steps: [readAgain(), readAgain(), readAgain()],
      ceiling: { maxModelCalls: 2, maxToolCalls: 20 },
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("ceiling");
    expect(result.modelCalls).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(model.remaining).toBe(1);
    expect(rowsOf(river).find((r) => r.kind === "note" && r.source === "body")).toMatchObject({
      text: "Turn stopped at the loop ceiling.",
    });
  });

  it("stops inside a reply at the tool-call ceiling, and says which calls were not run", async () => {
    const { input, river } = await setup({
      steps: [
        reply({
          toolCalls: [
            call("read_note", { path: "people/mara.md" }, "c1"),
            call("read_note", { path: "people/mara.md" }, "c2"),
          ],
        }),
      ],
      ceiling: { maxModelCalls: 5, maxToolCalls: 1 },
    });

    const { result, messages } = await runTurnWithMessages(input);

    expect(result.endedBy).toBe("ceiling");
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(result.receipts).toHaveLength(1);
    const notRun = toolMessages(messages).find((m) => m.toolCallId === "c2");
    expect(JSON.parse(notRun?.content ?? "{}")).toMatchObject({ ok: false, refused: { code: "not_run" } });
    expect(rowsOf(river).find((r) => r.kind === "note" && r.source === "body")?.data).toEqual({
      turnId: "turn-1",
      skipped: ["read_note"],
    });
  });

  it("stops at once when the ceiling is zero", async () => {
    const { input, model } = await setup({ steps: [reply({ content: "never" })], ceiling: { maxModelCalls: 0, maxToolCalls: 0 } });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("ceiling");
    expect(result.modelCalls).toBe(0);
    expect(model.requests).toHaveLength(0);
  });
});

describe("runTurn: failures and aborts", () => {
  it("ends with model_error when the model gives up, and records why", async () => {
    const { input, river } = await setup({
      steps: [new ModelError("The provider is down.", "unavailable", 3)],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("model_error");
    expect(result.error).toBe("The provider is down.");
    expect(result.modelCalls).toBe(1);
    expect(rowsOf(river).find((r) => r.kind === "note")).toMatchObject({
      source: "body",
      text: "The model could not answer: The provider is down.",
      data: { turnId: "turn-1", kind: "unavailable" },
    });
    expect(rowsOf(river).at(-1)?.data).toMatchObject({ phase: "end", endedBy: "model_error" });
  });

  it("treats any other error from the model as model_error too", async () => {
    const { input } = await setup({ steps: [new Error("socket reset")] });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("model_error");
    expect(result.error).toBe("socket reset");
  });

  it("stops before the first call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, model, river } = await setup({ steps: [reply({ content: "never" })], signal: controller.signal });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("aborted");
    expect(result.modelCalls).toBe(0);
    expect(model.requests).toHaveLength(0);
    expect(rowsOf(river).map((r) => r.kind)).toEqual(["turn", "turn"]);
  });

  it("ends as aborted when the signal fires while the model is answering", async () => {
    const controller = new AbortController();
    const { input } = await setup({ steps: [untilAborted()], signal: controller.signal });

    const pending = runTurn(input);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;

    expect(result.endedBy).toBe("aborted");
    expect(result.modelCalls).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it("ends as aborted when the signal fires during a tool, before the next model call", async () => {
    const controller = new AbortController();
    const pause: Tool = {
      spec: { name: "pause", description: "Stops the signal.", parameters: { type: "object", properties: {} } },
      async run(): Promise<Receipt> {
        controller.abort();
        return { ok: true, summary: "Paused." };
      },
    };
    const { input, model } = await setup({
      steps: [reply({ toolCalls: [call("pause", {}, "c1")] }), reply({ toolCalls: [call(END_TURN, {}, "c2")] })],
      tools: [pause],
      signal: controller.signal,
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("aborted");
    expect(result.modelCalls).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(model.remaining).toBe(1);
  });
});
