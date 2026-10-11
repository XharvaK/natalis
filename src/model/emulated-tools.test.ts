import { describe, expect, it } from "vitest";
import { ModelError, type ChatMessage, type ModelRequest, type ModelResponse, type ToolSpec } from "../contracts.js";
import { createScriptedModel } from "./mock.js";
import { MalformedToolBlock, withEmulatedTools } from "./emulated-tools.js";

const recall: ToolSpec = {
  name: "recall",
  description: "Find notes by words",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const block = (value: unknown): string => "```json\n" + JSON.stringify(value) + "\n```";

function setup(script: Array<Partial<ModelResponse>>) {
  const inner = createScriptedModel(script, { id: "plain:model", contextTokens: 4000, nativeTools: true });
  return { port: withEmulatedTools(inner), inner };
}

const ask = (messages: ChatMessage[], extra: Partial<ModelRequest> = {}): ModelRequest => ({ messages, ...extra });

describe("reply parsing", () => {
  it("reads a tool-call block into ToolCalls and keeps the words outside it", async () => {
    const { port } = setup([
      {
        content: `Let me look.\n${block({ tool_calls: [{ name: "recall", arguments: { query: "cats" } }] })}\nThen I will wait.`,
      },
    ]);
    const reply = await port.complete(ask([{ role: "user", content: "cats?" }], { tools: [recall] }));
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]?.name).toBe("recall");
    expect(reply.toolCalls[0]?.id).toMatch(/^emu_/);
    expect(JSON.parse(reply.toolCalls[0]?.arguments ?? "")).toEqual({ query: "cats" });
    expect(reply.content).toBe("Let me look.\nThen I will wait.");
    expect(reply.finish).toBe("tool_calls");
  });

  it("keeps string arguments as the raw text and gives missing arguments as an empty object", async () => {
    const { port } = setup([
      {
        content: block({
          tool_calls: [
            { name: "recall", arguments: '{"query":"dogs"}' },
            { name: "recall" },
          ],
        }),
      },
    ]);
    const reply = await port.complete(ask([{ role: "user", content: "x" }], { tools: [recall] }));
    expect(reply.toolCalls.map((call) => call.arguments)).toEqual(['{"query":"dogs"}', "{}"]);
    expect(reply.content).toBeNull();
  });

  it("refuses a malformed block when tools were offered, with a note that says why, and keeps the reply", async () => {
    const broken = "Searching now.\n```json\n{\"tool_calls\":[{\"name\":\"recall\",\"arguments\":\n```";
    const { port } = setup([{ content: broken }]);
    const error = await port.complete(ask([{ role: "user", content: "x" }], { tools: [recall] })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MalformedToolBlock);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ kind: "malformed", reply: broken });
    expect((error as MalformedToolBlock).note).toMatch(/^Your tool block was not valid JSON: \S/);
  });

  it("keeps a malformed block as plain content with no tool calls when no tools were offered", async () => {
    const broken = "Searching now.\n```json\n{\"tool_calls\":[{\"name\":\"recall\",\"arguments\":\n```";
    const { port } = setup([{ content: broken }]);
    const reply = await port.complete(ask([{ role: "user", content: "x" }]));
    expect(reply.toolCalls).toEqual([]);
    expect(reply.content).toBe(broken);
    expect(reply.finish).toBe("stop");
  });

  it("refuses a block with the wrong shape, and says what is missing", async () => {
    const wrong = block({ tool_calls: [{ arguments: { query: "x" } }] });
    const { port } = setup([{ content: wrong }]);
    const error = await port.complete(ask([{ role: "user", content: "x" }], { tools: [recall] })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MalformedToolBlock);
    expect((error as MalformedToolBlock).note).toBe(
      "Your tool block was not in the tool-call shape: every call needs a name. Send the block again in the shape given, or answer in plain words.",
    );
    expect((error as MalformedToolBlock).reply).toBe(wrong);
  });

  it("leaves a plain reply and a non-tool json block alone", async () => {
    const example = block({ mood: "calm" });
    const { port } = setup([{ content: "Just talking." }, { content: example }]);
    const first = await port.complete(ask([{ role: "user", content: "x" }], { tools: [recall] }));
    expect(first).toMatchObject({ content: "Just talking.", toolCalls: [], finish: "stop" });
    const second = await port.complete(ask([{ role: "user", content: "x" }], { tools: [recall] }));
    expect(second).toMatchObject({ content: example, toolCalls: [] });
  });

  it("reports nativeTools false and the inner model's id", () => {
    const { port } = setup([]);
    expect(port.info).toEqual({ id: "plain:model", contextTokens: 4000, nativeTools: false });
  });
});

describe("request shaping", () => {
  it("sends no tools field to the inner model", async () => {
    const { port, inner } = setup([{ content: "hi" }]);
    await port.complete(ask([{ role: "user", content: "x" }], { tools: [recall], toolChoice: "required" }));
    const sent = inner.requests[0];
    expect(sent).toBeDefined();
    expect("tools" in (sent ?? {})).toBe(false);
    expect("toolChoice" in (sent ?? {})).toBe(false);
  });

  it("appends the tool description to the system message", async () => {
    const { port, inner } = setup([{ content: "hi" }]);
    await port.complete(
      ask(
        [
          { role: "system", content: "You are Natalis." },
          { role: "user", content: "x" },
        ],
        { tools: [recall] },
      ),
    );
    const system = inner.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    const text = system?.role === "system" ? system.content : "";
    expect(text.startsWith("You are Natalis.\n\n")).toBe(true);
    expect(text).toContain("recall: Find notes by words");
    expect(text).toContain(JSON.stringify(recall.parameters));
    expect(text).toContain('{"tool_calls":[{"name":"<tool name>","arguments":{}}]}');
  });

  it("adds a system message when there is none", async () => {
    const { port, inner } = setup([{ content: "hi" }]);
    await port.complete(ask([{ role: "user", content: "x" }], { tools: [recall] }));
    const sent = inner.requests[0]?.messages ?? [];
    expect(sent[0]?.role).toBe("system");
    expect(sent[1]).toEqual({ role: "user", content: "x" });
  });

  it("round-trips a tool loop through the history as plain text", async () => {
    const { port, inner } = setup([
      { content: `Checking.\n${block({ tool_calls: [{ name: "recall", arguments: { query: "cats" } }] })}` },
      { content: "Two notes." },
    ]);
    const first = await port.complete(ask([{ role: "user", content: "cats?" }], { tools: [recall] }));
    expect(first.toolCalls).toHaveLength(1);
    const call = first.toolCalls[0];
    expect(call).toBeDefined();

    const history: ChatMessage[] = [
      { role: "user", content: "cats?" },
      { role: "assistant", content: first.content, toolCalls: first.toolCalls },
      { role: "tool", toolCallId: call?.id ?? "", content: "two notes" },
      { role: "user", content: "thanks" },
    ];
    const second = await port.complete(ask(history, { tools: [recall] }));
    expect(second).toMatchObject({ content: "Two notes.", toolCalls: [] });

    const sent = inner.requests[1]?.messages ?? [];
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "user"]);
    const assistant = sent[2];
    expect(assistant?.role).toBe("assistant");
    const assistantText = assistant?.role === "assistant" ? (assistant.content ?? "") : "";
    expect(assistantText.startsWith("Checking.\n\n```json\n")).toBe(true);
    const parsed = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(assistantText)?.[1] ?? "null");
    expect(parsed).toEqual({ tool_calls: [{ name: "recall", arguments: { query: "cats" } }] });
    expect(sent[3]).toEqual({ role: "user", content: `Tool result (${call?.id}): two notes` });
    expect(sent[4]).toEqual({ role: "user", content: "thanks" });
  });

  it("does not describe tools when toolChoice is none", async () => {
    const { port, inner } = setup([{ content: "hi" }]);
    await port.complete(ask([{ role: "system", content: "S" }, { role: "user", content: "x" }], { tools: [recall], toolChoice: "none" }));
    expect(inner.requests[0]?.messages[0]).toEqual({ role: "system", content: "S" });
  });
});
