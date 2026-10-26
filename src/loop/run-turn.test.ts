import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ModelError, type ChatMessage, type Receipt, type RiverRow, type Tool } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { ScriptedModel, call, reply, untilAborted, type ScriptStep } from "../testing/scripted-model.js";
import { withEmulatedTools } from "../model/emulated-tools.js";
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

  it("keeps the reasoning summary as a thought and sends the provider state back within the turn", async () => {
    const state = { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }] };
    const { input, model, river } = await setup({
      steps: [
        { ...reply({ toolCalls: [call("read_note", { path: "people/mara.md" }, "c1")] }), reasoning: "Look at Mara's note.", providerState: state },
        reply({ toolCalls: [call(END_TURN, {}, "c2")] }),
      ],
    });

    await runTurn(input);

    expect(rowsOf(river).find((r) => r.kind === "note")).toMatchObject({
      text: "Look at Mara's note.",
      data: { thought: true, reasoning: true, turnId: "turn-1" },
    });
    const sent = model.requests[1]?.messages.find((m) => m.role === "assistant");
    expect(sent).toMatchObject({ role: "assistant", providerState: state });
  });

  it("keeps a receipt's data on its river row: the first 2 KB of its JSON, and a SHA-256 of all of it", async () => {
    const page = { page: "ö".repeat(5000) };
    const bulky: Tool = {
      spec: { name: "bulk", description: "Returns a lot.", parameters: { type: "object", properties: {} } },
      async run(): Promise<Receipt> {
        return { ok: true, summary: "Read the big page.", data: page };
      },
    };
    const { input, river } = await setup({
      tools: [bulky],
      steps: [reply({ toolCalls: [call("bulk")] }), reply({ toolCalls: [call("end_turn")] })],
    });
    await runTurn(input);
    const receipt = rowsOf(river).find((row) => row.kind === "receipt");
    const whole = JSON.stringify(page);
    expect(receipt?.text).toBe("Read the big page.");
    const kept = String(receipt?.data?.["dataJson"]);
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(kept)).toBeGreaterThan(2000);
    expect(whole.startsWith(kept)).toBe(true);
    expect(receipt?.data).toMatchObject({
      dataBytes: Buffer.byteLength(whole),
      dataSha256: createHash("sha256").update(whole).digest("hex"),
    });
  });

  it("records the model, its effort and the tokens the provider reported on the turn's end row", async () => {
    const { input, river } = await setup({
      effort: "high",
      steps: [
        { ...reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] }), usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
        // The backup answers this call: its tokens are counted in the turn and also on their own.
        { ...reply({ toolCalls: [call("end_turn")] }), usage: { inputTokens: 5 }, servedBy: "backup-model" },
      ],
    });
    await runTurn(input);
    const end = rowsOf(river).find((row) => row.kind === "turn" && row.data?.["phase"] === "end");
    expect(end?.data).toMatchObject({
      model: "scripted:test-model",
      effort: "high",
      tokens: { prompt: 15, completion: 4, total: 14 },
      backupTokens: { prompt: 5 },
    });
  });

  it("puts the cached-prompt counts the provider reported on the end row, summed over the turn's calls", async () => {
    const { input, river } = await setup({
      steps: [
        { ...reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] }), usage: { inputTokens: 10, cacheHitTokens: 8 } },
        { ...reply({ toolCalls: [call("end_turn")] }), usage: { inputTokens: 12, cacheHitTokens: 4, cacheMissTokens: 8 } },
      ],
    });
    await runTurn(input);
    const end = rowsOf(river).find((row) => row.kind === "turn" && row.data?.["phase"] === "end");
    expect(end?.data).toMatchObject({ cacheHitTokens: 12, cacheMissTokens: 8 });
  });

  it("leaves the cache counts off the end row when no call reported them", async () => {
    const { input, river } = await setup({ steps: [{ ...reply({ toolCalls: [call("end_turn")] }), usage: { inputTokens: 3 } }] });
    await runTurn(input);
    const end = rowsOf(river).find((row) => row.kind === "turn" && row.data?.["phase"] === "end");
    expect(end?.data?.["cacheHitTokens"]).toBeUndefined();
    expect(end?.data?.["cacheMissTokens"]).toBeUndefined();
  });

  it("leaves the token counts off the end row when no call reported any", async () => {
    const { input, river } = await setup({ steps: [reply({ toolCalls: [call("end_turn")] })] });
    await runTurn(input);
    const end = rowsOf(river).find((row) => row.kind === "turn" && row.data?.["phase"] === "end");
    expect(end?.data?.["tokens"]).toBeUndefined();
    expect(end?.data?.["backupTokens"]).toBeUndefined();
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
    expect(rows[6]?.data).toEqual({ phase: "end", endedBy: "end_turn", turnId: "turn-1", modelCalls: 2, toolCalls: 2, model: "scripted:test-model" });
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
  it("runs end_turn after the other calls of its reply, even when it is listed first", async () => {
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
    expect(result.receipts.map((r) => r.tool)).toEqual(["read_note", END_TURN]);
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

describe("runTurn: pictures a tool hands over", () => {
  const show: Tool = {
    spec: { name: "show", description: "Shows a picture.", parameters: { type: "object", properties: {} } },
    async run(): Promise<Receipt> {
      return { ok: true, summary: "Here is the picture.", images: [{ type: "image", mime: "image/png", dataBase64: "AAAA" }] };
    },
  };
  const noop: Tool = {
    spec: { name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} } },
    async run(): Promise<Receipt> {
      return { ok: true, summary: "Nothing." };
    },
  };

  it("shows the picture on the next call only, and keeps it out of the record and the tool message", async () => {
    const { input, model, river } = await setup({
      tools: [show, noop],
      steps: [
        reply({ toolCalls: [call("show", {}, "c1")] }),
        reply({ toolCalls: [call("noop", {}, "c2")] }),
        reply({ toolCalls: [call(END_TURN, {}, "c3")] }),
      ],
    });
    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(model.requests[0]?.messages.some((m) => m.role === "user" && m.images !== undefined)).toBe(false);
    const shown = model.requests[1]?.messages.at(-1);
    expect(shown).toMatchObject({ role: "user", images: [{ type: "image", mime: "image/png", dataBase64: "AAAA" }] });
    expect(model.requests[2]?.messages.some((m) => m.role === "user" && m.images !== undefined)).toBe(false);
    expect(JSON.stringify(rowsOf(river))).not.toContain("AAAA");
    expect(toolMessages(model.requests[1]?.messages ?? []).map((item) => item.content).join("\n")).not.toContain("AAAA");
    expect(result.receipts[0]?.receipt).toEqual({ ok: true, summary: "Here is the picture." });
  });
});

describe("runTurn: a tool block the host cannot read", () => {
  const broken = 'Let me look.\n```json\n{"tool_calls":[{"name":"end_turn","arguments":\n```';

  it("tells the model why, keeps its words, and lets it try again within the ceiling", async () => {
    const inner = new ScriptedModel([reply({ content: broken }), reply({ toolCalls: [call(END_TURN, {})] })], {
      nativeTools: true,
    });
    const { input, river } = await setup({ steps: [] });
    const result = await runTurn({ ...input, model: withEmulatedTools(inner) });

    expect(result.endedBy).toBe("end_turn");
    expect(result.modelCalls).toBe(2);
    const note = rowsOf(river).find((r) => r.kind === "note" && r.source === "body");
    expect(note?.text).toMatch(/^Your tool block was not valid JSON: \S/);
    expect(note?.data).toMatchObject({ kind: "malformed_tool_block", turnId: "turn-1" });
    const second = inner.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", content: expect.stringContaining("Let me look.") });
    expect(second.at(-1)).toMatchObject({ role: "user", content: note?.text });
  });

  it("stops at the ceiling when the model keeps writing a block the host cannot read", async () => {
    const inner = new ScriptedModel([reply({ content: broken }), reply({ content: broken })], { nativeTools: true });
    const { input, river } = await setup({ steps: [] });
    const result = await runTurn({ ...input, model: withEmulatedTools(inner), ceiling: { maxModelCalls: 2, maxToolCalls: 5 } });

    expect(result.endedBy).toBe("ceiling");
    expect(result.modelCalls).toBe(2);
    expect(rowsOf(river).filter((r) => r.kind === "note" && r.source === "body")).toHaveLength(3);
  });
});

describe("runTurn: a backup model answered", () => {
  it("writes one body note per turn that says which backup answered, and not once per call", async () => {
    const backed = { ...reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] }), servedBy: "backup-model" };
    const { input, river } = await setup({
      steps: [backed, { ...reply({ toolCalls: [call("end_turn")] }), servedBy: "backup-model" }],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    const notes = rowsOf(river).filter((r) => r.kind === "note" && r.data?.["kind"] === "backup_model");
    expect(notes).toEqual([
      expect.objectContaining({
        source: "body",
        text: "Your main model did not answer; your backup model (backup-model) answered this turn.",
        data: expect.objectContaining({ turnId: "turn-1", kind: "backup_model", model: "backup-model" }),
      }),
    ]);
  });

  it("writes no such note when the main model answered", async () => {
    const { input, river } = await setup({ steps: [reply({ toolCalls: [call("end_turn")] })] });
    await runTurn(input);
    expect(rowsOf(river).some((r) => r.data?.["kind"] === "backup_model")).toBe(false);
  });
});

describe("runTurn: end_turn rides with the last acts", () => {
  it("runs end_turn after the other calls, and writes its tool message last", async () => {
    const { input } = await setup({
      steps: [
        reply({ toolCalls: [call(END_TURN, {}, "c1"), call("read_note", { path: "people/mara.md" }, "c2")] }),
      ],
    });

    const { result, messages } = await runTurnWithMessages(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.modelCalls).toBe(1);
    expect(toolMessages(messages).map((m) => m.toolCallId)).toEqual(["c2", "c1"]);
    expect(toolMessages(messages).at(-1)?.content).toContain('"ok":true');
  });

  it("reopens the turn when an earlier call was refused, says why in end_turn's receipt, and lets the next reply end it", async () => {
    const { input, model, river } = await setup({
      steps: [
        reply({ toolCalls: [call("no_such_tool", {}, "c1"), call(END_TURN, {}, "c2")] }),
        reply({ toolCalls: [call(END_TURN, {}, "c3")] }),
      ],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.modelCalls).toBe(2);
    expect(result.receipts.map((r) => r.tool)).toEqual(["no_such_tool", END_TURN, END_TURN]);
    expect(result.receipts[1]?.receipt).toEqual({
      ok: false,
      summary: "The turn stays open.",
      refused: { code: "reopened", reason: "An earlier call in this reply was refused or held: see its receipt." },
    });
    // The next model call sees every receipt, the reopened one included.
    expect(model.requests[1]?.messages.some((m) => m.role === "tool" && m.content.includes('"code":"reopened"'))).toBe(true);
    const receipts = river.read({ thread: THREAD, kinds: ["receipt"] });
    expect(receipts.some((row) => row.data?.["refused"] && JSON.stringify(row.data["refused"]).includes("reopened"))).toBe(true);
  });

  it("reopens the turn when an earlier call failed inside its tool", async () => {
    const { input } = await setup({
      tools: [...notebookTools(), boomTool],
      steps: [
        reply({ toolCalls: [call("boom", {}, "c1"), call(END_TURN, {}, "c2")] }),
        reply({ toolCalls: [call(END_TURN, {}, "c3")] }),
      ],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("end_turn");
    expect(result.receipts.map((r) => r.receipt.ok)).toEqual([false, false, true]);
    expect(result.receipts[1]?.receipt.refused?.code).toBe("reopened");
  });

  it("keeps the ceiling: a reopened turn that reaches its model-call limit ends there", async () => {
    const { input } = await setup({
      ceiling: { maxModelCalls: 1, maxToolCalls: 20 },
      steps: [reply({ toolCalls: [call("no_such_tool", {}, "c1"), call(END_TURN, {}, "c2")] })],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("ceiling");
    expect(result.modelCalls).toBe(1);
    expect(result.receipts.at(-1)?.receipt.refused?.code).toBe("reopened");
  });

  it("still ends a turn on a plain reply with no tool call", async () => {
    const { input } = await setup({ steps: [reply({ content: "Just a word." })] });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("no_tool_call");
    expect(result.toolCalls).toBe(0);
  });
});

describe("runTurnWithMessages: the layout of the system text and the event", () => {
  it("carries each message's layout on the message, and leaves the text as it was given", async () => {
    const system = "## who\nA test.\n\n## nature\nA voice.";
    const event = "Recent here:\nrow\n\nNew:\nnew row";
    const systemLayout = [
      { name: "who", cls: "fixed" as const, end: 9 },
      { name: "nature", cls: "notes" as const, end: system.length },
    ];
    const eventLayout = [
      { name: "recent", cls: "page" as const, end: 17 },
      { name: "new", cls: "turn" as const, end: event.length },
    ];
    const { input } = await setup({
      system,
      event,
      systemLayout,
      eventLayout,
      steps: [reply({ toolCalls: [call(END_TURN, {}, "c1")] })],
    });

    const { messages } = await runTurnWithMessages(input);

    expect(messages[0]).toEqual({ role: "system", content: system, layout: systemLayout });
    expect(messages[1]).toEqual({ role: "user", content: event, layout: eventLayout });
  });

  it("sends a message without a layout with no layout key at all", async () => {
    const { input } = await setup({ steps: [reply({ toolCalls: [call(END_TURN, {}, "c1")] })] });

    const { messages } = await runTurnWithMessages(input);

    expect(messages[0]).toEqual({ role: "system", content: "You are Iris, a test entity." });
    expect("layout" in (messages[0] ?? {})).toBe(false);
  });
});

describe("runTurn: the turn on each call", () => {
  it("sends the turn's id with every model call, so a backup can hold for the rest of the turn", async () => {
    const { input, model } = await setup({
      steps: [reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] }), reply({ toolCalls: [call(END_TURN)] })],
    });

    await runTurn(input);

    expect(model.requests.map((request) => request.turnId)).toEqual(["turn-1", "turn-1"]);
  });

  it("says in the backup note why the main model did not answer", async () => {
    const backed = {
      ...reply({ toolCalls: [call(END_TURN)] }),
      servedBy: "backup-model",
      mainError: "no output from the model service for 120000 ms",
    };
    const { input, river } = await setup({ steps: [backed] });

    await runTurn(input);

    const note = rowsOf(river).find((r) => r.data?.["kind"] === "backup_model");
    expect(note?.text).toBe(
      "Your main model did not answer; your backup model (backup-model) answered this turn. Why: no output from the model service for 120000 ms",
    );
    expect(note?.data?.["mainError"]).toBe("no output from the model service for 120000 ms");
  });
});

describe("runTurn: calls left", () => {
  const read = (): ScriptStep => reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] });
  const lastUser = (messages: ChatMessage[]): string => {
    const last = messages[messages.length - 1];
    return last?.role === "user" ? last.content : "";
  };

  it("tells the model how many calls are left once a quarter are left, and keeps the line out of the turn", async () => {
    const { input, model } = await setup({
      steps: [read(), read(), read(), read(), read(), read(), read(), read(), read(), reply({ toolCalls: [call(END_TURN)] })],
      ceiling: { maxModelCalls: 12, maxToolCalls: 40 },
    });

    const { messages } = await runTurnWithMessages(input);

    // 12 calls: a quarter is 3, so the line shows from the tenth call on, when 3 are left.
    expect(lastUser(model.requests[8]?.messages ?? [])).not.toContain("Calls left");
    expect(lastUser(model.requests[9]?.messages ?? [])).toBe(
      "Calls left in this turn, this one included: 3 model calls and 31 tool calls. Then the turn stops.",
    );
    expect(messages.some((m) => m.role === "user" && m.content.includes("Calls left"))).toBe(false);
  });

  it("counts tool calls too, and names the closing call when there is one", async () => {
    const { input, model } = await setup({
      steps: [reply({ toolCalls: [call("read_note", { path: "people/mara.md" }), call("read_note", { path: "people/mara.md" })] }), read()],
      ceiling: { maxModelCalls: 40, maxToolCalls: 5 },
      closingTools: ["append_note"],
    });

    await runTurn(input);

    expect(lastUser(model.requests[1]?.messages ?? [])).toBe(
      "Calls left in this turn, this one included: 39 model calls and 3 tool calls. Then the turn stops, and you get one last call to keep a note.",
    );
  });

  it("puts the line beside pictures a tool handed over, in the same message", async () => {
    const picture = { type: "image" as const, mime: "image/png", dataBase64: "AAAA" };
    const looker: Tool = {
      spec: { name: "look", description: "Look.", parameters: { type: "object", properties: {} } },
      async run(): Promise<Receipt> {
        return { ok: true, summary: "Here it is.", images: [picture] };
      },
    };
    const { input, model } = await setup({
      steps: [reply({ toolCalls: [call("look")] }), reply({ toolCalls: [call(END_TURN)] })],
      tools: [looker],
      ceiling: { maxModelCalls: 2, maxToolCalls: 40 },
    });

    await runTurn(input);

    const last = model.requests[1]?.messages.at(-1);
    expect(last).toMatchObject({ role: "user", images: [picture] });
    expect(last?.role === "user" ? last.content : "").toContain("You see it on this call only.\nCalls left in this turn");
  });
});

describe("runTurn: the closing call", () => {
  const read = (): ScriptStep => reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] });

  it("makes one last call at the ceiling with only the closing tools, and keeps the note", async () => {
    const { input, model, notebook } = await setup({
      steps: [read(), read(), reply({ toolCalls: [call("append_note", { path: "diary.md", text: "Read about Mara.", why: "diary" })] })],
      ceiling: { maxModelCalls: 2, maxToolCalls: 40 },
      closingTools: ["append_note", "write_note"],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("ceiling");
    expect(result.modelCalls).toBe(3);
    expect(model.requests[2]?.tools?.map((t) => t.name)).toEqual(["write_note", "append_note", END_TURN]);
    const asked = model.requests[2]?.messages.at(-1);
    expect(asked?.role === "user" ? asked.content : "").toContain("This is its last call: you can keep a note with write_note, append_note");
    expect(notebook.read("diary.md")).toContain("Read about Mara.");
  });

  it("does not run a tool that is not a closing tool, and runs at most three", async () => {
    const appendCall = (n: number) => call("append_note", { path: "diary.md", text: `line ${n}`, why: "diary" });
    const { input, notebook } = await setup({
      steps: [read(), reply({ toolCalls: [call("read_note", { path: "people/mara.md" }), appendCall(1), appendCall(2), appendCall(3), appendCall(4)] })],
      ceiling: { maxModelCalls: 1, maxToolCalls: 40 },
      closingTools: ["append_note"],
    });

    const { messages } = await runTurnWithMessages(input);

    const diary = notebook.read("diary.md") ?? "";
    expect(diary).toContain("line 3");
    expect(diary).not.toContain("line 4");
    const notRun = toolMessages(messages).map((m) => JSON.parse(m.content)).filter((r) => r.refused?.code === "not_run");
    expect(notRun.map((r) => r.refused.reason)).toEqual([
      "The turn is at its limit: only a note can be kept now.",
      "The closing call's calls are used up.",
    ]);
  });

  it("records a failed closing call and still ends the turn at the ceiling", async () => {
    const { input, river } = await setup({
      steps: [read(), new ModelError("service is down", "unavailable", 4)],
      ceiling: { maxModelCalls: 1, maxToolCalls: 40 },
      closingTools: ["append_note"],
    });

    const result = await runTurn(input);

    expect(result.endedBy).toBe("ceiling");
    expect(result.error).toBeUndefined();
    expect(rowsOf(river).find((r) => r.data?.["kind"] === "closing_call")?.text).toBe("The closing call failed: service is down");
  });

  it("makes no closing call without closing tools, or when the ceiling is zero", async () => {
    const without = await setup({ steps: [read()], ceiling: { maxModelCalls: 1, maxToolCalls: 40 } });
    expect((await runTurn(without.input)).modelCalls).toBe(1);

    const zero = await setup({ steps: [read()], ceiling: { maxModelCalls: 0, maxToolCalls: 0 }, closingTools: ["append_note"] });
    expect((await runTurn(zero.input)).modelCalls).toBe(0);
  });
});

describe("runTurn: shortening older results", () => {
  const bulky: Tool = {
    spec: { name: "bulk", description: "Returns a lot.", parameters: { type: "object", properties: {} } },
    async run(): Promise<Receipt> {
      return { ok: true, summary: "A long page.", data: { page: "p".repeat(6000) } };
    },
  };
  const bulk = (): ScriptStep => reply({ toolCalls: [call("bulk")] });

  it("shortens results before the newest reply once they pass the budget, and keeps them short", async () => {
    const { input, model, river } = await setup({
      steps: [bulk(), bulk(), bulk(), bulk(), reply({ toolCalls: [call(END_TURN)] })],
      tools: [bulky],
      ceiling: { maxModelCalls: 40, maxToolCalls: 40, wholeResultsChars: 10_000 },
    });

    const result = await runTurn(input);

    const sizes = (i: number) => toolMessages(model.requests[i]?.messages ?? []).map((m) => m.content.length);
    // Call 3: one result before the newest reply, under the budget, so all stay whole.
    expect(sizes(2).every((size) => size > 6000)).toBe(true);
    // Call 4: two results before the newest reply, over the budget together, so both are shortened; the newest stays whole.
    const fourth = sizes(3);
    expect(fourth[0]).toBeLessThan(2500);
    expect(fourth[1]).toBeLessThan(2500);
    expect(fourth[2]).toBeGreaterThan(6000);
    // Call 5: a shortened result is the same text as before, and the one older result left is under the budget.
    const fifth = toolMessages(model.requests[4]?.messages ?? []);
    expect(fifth[0]?.content).toBe(toolMessages(model.requests[3]?.messages ?? [])[0]?.content);
    expect(fifth[2]?.content.length).toBeGreaterThan(6000);
    const short = JSON.parse(fifth[0]?.content ?? "{}");
    expect(short).toMatchObject({ ok: true, summary: "A long page." });
    expect(short.shortened).toMatch(/^This result was shortened to keep this turn small: it was \d+ characters\. Call the tool again/);
    expect(String(short.dataStart).length).toBeLessThanOrEqual(2048);
    expect(result.endedBy).toBe("end_turn");
    expect(rowsOf(river).find((r) => r.kind === "turn" && r.data?.["phase"] === "end")?.data?.["shortenedResults"]).toBe(2);
  });

  it("never shortens without a budget, and leaves small results whole", async () => {
    const plain = await setup({ steps: [bulk(), bulk(), bulk(), reply({ toolCalls: [call(END_TURN)] })], tools: [bulky] });
    await runTurn(plain.input);
    expect(toolMessages(plain.model.requests[3]?.messages ?? []).every((m) => m.content.length > 6000)).toBe(true);

    const readMara = (): ScriptStep => reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] });
    const small = await setup({
      steps: [readMara(), readMara(), reply({ toolCalls: [call(END_TURN)] })],
      ceiling: { maxModelCalls: 40, maxToolCalls: 40, wholeResultsChars: 10 },
    });
    await runTurn(small.input);
    expect(toolMessages(small.model.requests[2]?.messages ?? [])[0]?.content).toContain("Mara likes tea.");
  });
});

describe("runTurn: what came in during the turn", () => {
  it("shows the arrivals line on each call that has one, after pictures and before calls left, and never keeps it", async () => {
    const said: Array<string | undefined> = [undefined, "New here since this turn began:\n[08:30 mara] One more thing."];
    let asked = 0;
    const { input, model } = await setup({
      steps: [reply({ toolCalls: [call("read_note", { path: "people/mara.md" })] }), reply({ toolCalls: [call(END_TURN)] })],
      ceiling: { maxModelCalls: 2, maxToolCalls: 40 },
      arrivals: () => said[asked++],
    });

    const { messages } = await runTurnWithMessages(input);

    expect(asked).toBe(2);
    const first = model.requests[0]?.messages.at(-1);
    expect(first?.role === "user" ? first.content : "").not.toContain("New here");
    const last = model.requests[1]?.messages.at(-1);
    expect(last?.role === "user" ? last.content : "").toBe(
      "New here since this turn began:\n[08:30 mara] One more thing.\nCalls left in this turn, this one included: 1 model call and 39 tool calls. Then the turn stops.",
    );
    expect(messages.some((m) => m.role === "user" && m.content.includes("New here"))).toBe(false);
  });
});

describe("runTurn round 6: the turn deadline covers tools", () => {
  it("S1: a tool that awaits forever ends the turn as a model error within about 100 ms of a 20 ms deadline", async () => {
    const { withTurnDeadline } = await import("../model/turn-deadline.js");
    const hang: Tool = {
      spec: { name: "hang", description: "Never returns.", parameters: { type: "object", properties: {} } },
      run: () => new Promise<Receipt>(() => {}),
    };
    const { input } = await setup({ steps: [reply({ toolCalls: [call("hang", {}, "c1")] }), reply({ toolCalls: [call(END_TURN, { note: "x" }, "c2")] })], tools: [hang] });
    const dog = withTurnDeadline(input.model, 20, () => {});
    const started = Date.now();
    const result = await Promise.race([
      runTurn({ ...input, model: dog.model, deadline: dog.signal } as RunTurnInput),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 500)),
    ]).finally(() => dog.done());
    expect(result).not.toBe("hung");
    expect(Date.now() - started).toBeLessThan(150);
    expect((result as { endedBy: string }).endedBy).toBe("model_error");
  });

  it("S-A: a settling tool (a local notebook write) is let finish after the deadline, and its real receipt is kept", async () => {
    const { withTurnDeadline } = await import("../model/turn-deadline.js");
    let wrote = false;
    const append: Tool = {
      spec: { name: "append_slow", description: "Appends late.", parameters: { type: "object", properties: {} } },
      settles: true,
      run: () => new Promise<Receipt>((resolve) => setTimeout(() => { wrote = true; resolve({ ok: true, summary: "Appended." }); }, 50)),
    };
    const { input, river } = await setup({ steps: [reply({ toolCalls: [call("append_slow", {}, "c1")] }), reply({ toolCalls: [call(END_TURN, { note: "x" }, "c2")] })], tools: [append] });
    const dog = withTurnDeadline(input.model, 20, () => {});
    await runTurn({ ...input, model: dog.model, deadline: dog.signal } as RunTurnInput).finally(() => dog.done());
    expect(wrote).toBe(true);
    const receipt = river.read({ thread: THREAD }).find((r) => r.kind === "receipt" && r.data?.["callId"] === "c1");
    expect(receipt?.data?.["ok"]).toBe(true);
  });

  it("S-A: any other tool still running at the deadline gets an outcome-unknown receipt, not a failure", async () => {
    const { withTurnDeadline } = await import("../model/turn-deadline.js");
    const post: Tool = {
      spec: { name: "post_slow", description: "Posts late.", parameters: { type: "object", properties: {} } },
      run: () => new Promise<Receipt>(() => {}),
    };
    const { input, river } = await setup({ steps: [reply({ toolCalls: [call("post_slow", {}, "c1")] }), reply({ toolCalls: [call(END_TURN, { note: "x" }, "c2")] })], tools: [post] });
    const dog = withTurnDeadline(input.model, 20, () => {});
    await runTurn({ ...input, model: dog.model, deadline: dog.signal } as RunTurnInput).finally(() => dog.done());
    const receipt = river.read({ thread: THREAD }).find((r) => r.kind === "receipt" && r.data?.["callId"] === "c1");
    expect(receipt?.data?.["refused"]).toMatchObject({ code: "outcome_unknown" });
    expect(receipt?.text).toContain("may still finish");
  });
});

