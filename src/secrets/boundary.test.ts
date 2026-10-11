import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../contracts.js";
import { MemoryNotebook } from "../testing/memory-notebook.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { ScriptedModel } from "../testing/scripted-model.js";
import { guardModel, guardNotebook, guardRiver } from "./boundary.js";
import { createSecretScanner } from "./scanner.js";

// Built from parts so no token-shaped literal sits in the source.
const token = ["gh", "p_", "Q".repeat(36)].join("");
const vaultValue = ["lamp", "post", "-", "ninety", "-", "three"].join("");

describe("secret boundaries", () => {
  const scanner = createSecretScanner({ knownValues: [vaultValue] });

  it("keeps credentials out of the river's text and data", () => {
    const river = guardRiver(new MemoryRiver(), scanner);
    const row = river.append({ thread: "dm:owner", kind: "event", source: "owner", text: `here: ${token}`, data: { args: `{"k":"${vaultValue}"}` } });
    const stored = river.read({})[0]!;
    expect(row.seq).toBe(stored.seq);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(vaultValue);
    expect(stored.text).toContain("[secret:");
  });

  it("keeps credentials out of notebook writes", async () => {
    const notebook = guardNotebook(new MemoryNotebook(), scanner);
    await notebook.write("accounts/site.md", `login uses ${vaultValue}`, "note the site", "thread:test");
    await notebook.append("accounts/site.md", `and ${token}`, "more", "thread:test");
    const text = notebook.read("accounts/site.md")!;
    expect(text).not.toContain(vaultValue);
    expect(text).not.toContain(token);
  });

  it("redacts every message the model is sent, tool calls and tool results included", async () => {
    const inner = new ScriptedModel([{ content: "ok", toolCalls: [], finish: "stop", latencyMs: 1 }]);
    const model = guardModel(inner, scanner);
    const request: ModelRequest = {
      messages: [
        { role: "system", content: `system ${token}` },
        { role: "user", content: `user ${vaultValue}` },
        { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "read_note", arguments: `{"path":"${token}"}` }] },
        { role: "tool", toolCallId: "c1", content: `result ${vaultValue}` },
      ],
    };
    await model.complete(request);
    const sent = JSON.stringify(inner.requests[0]);
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(vaultValue);
  });
});

describe("secret boundaries: escaped values in data", () => {
  // Built from parts: a quote, a backslash and a newline, which JSON.stringify writes as escapes.
  const fake = ["fake", '"', "key", "\\", "tail", "\n", "end"].join("");
  const escaped = JSON.stringify(fake).slice(1, -1);
  const scanner = createSecretScanner({ knownValues: [fake] });

  it("keeps a known value out of the data whether it sits raw or escaped in a string", () => {
    const river = guardRiver(new MemoryRiver(), scanner);
    river.append({
      thread: "dm:owner",
      kind: "tool_call",
      source: "self",
      data: { raw: fake, nested: { list: [`x ${escaped}`] }, [`key ${escaped}`]: 1 },
    });
    const stored = river.read({})[0]!;
    expect(JSON.stringify(stored)).not.toContain(escaped);
    expect(JSON.stringify(stored.data)).toContain("[secret:known_value]");
    expect(stored.data).toEqual({
      raw: "[secret:known_value]",
      nested: { list: ["x [secret:known_value]"] },
      "key [secret:known_value]": 1,
    });
  });

  it("keeps the data object as it was when nothing is known in it", () => {
    const river = guardRiver(new MemoryRiver(), scanner);
    river.append({ thread: "dm:owner", kind: "event", source: "owner", data: { note: "plain words only" } });
    expect(river.read({})[0]!.data).toEqual({ note: "plain words only" });
  });
});
