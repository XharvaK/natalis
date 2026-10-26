import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSecretScanner, guardRiver } from "../secrets/index.js";
import { MemoryRiver } from "../testing/memory-river.js";
import { createEventBus, eventTypeOf, jsonlExporter, observeRiver, type NatalisEvent } from "./events.js";

const NOW = Date.UTC(2026, 9, 26, 12);

describe("event types", () => {
  it("names each row kind with one fixed type", () => {
    const t = (kind: string, data?: Record<string, unknown>) => eventTypeOf({ kind, data } as never);
    expect(t("turn", { phase: "start" })).toBe("turn.started");
    expect(t("turn", { phase: "end", endedBy: "end_turn" })).toBe("turn.completed");
    expect(t("turn", { phase: "end", endedBy: "model_error" })).toBe("turn.failed");
    expect(t("tool_call")).toBe("tool.called");
    expect(t("receipt")).toBe("tool.result");
    expect(t("note", { retryOf: "recall" })).toBe("tool.retry");
    expect(t("note", { wakeSkipped: "w1" })).toBe("wake.skipped");
    expect(t("event", { wakeId: "w1" })).toBe("wake.fired");
    expect(t("say")).toBe("say");
    expect(t("note")).toBe("row.note");
  });
});

describe("read-only hooks", () => {
  function setup() {
    const bus = createEventBus({ onError: (message) => errors.push(message) });
    const errors: string[] = [];
    const river = observeRiver(new MemoryRiver({ nowMs: () => NOW }), bus, "live");
    return { bus, errors, river };
  }

  it("calls hooks after the row is recorded, with its seq, and by type or for all", () => {
    const { bus, river } = setup();
    const all: NatalisEvent[] = [];
    const says: NatalisEvent[] = [];
    bus.on("*", (event) => all.push(event));
    bus.on("say", (event) => says.push(event));
    const row = river.append({ thread: "dm:owner", kind: "say", source: "self", text: "Hi." });
    river.append({ thread: "self", kind: "note", source: "body", text: "n" });
    expect(all.map((e) => e.type)).toEqual(["say", "row.note"]);
    expect(says).toHaveLength(1);
    expect(says[0]).toMatchObject({ type: "say", seq: row.seq, thread: "dm:owner", purpose: "live" });
    expect(river.read({ thread: "dm:owner" })).toHaveLength(1);
  });

  it("a hook that throws is logged and skipped; the append and the other hooks still run", () => {
    const { bus, errors, river } = setup();
    const after: string[] = [];
    bus.on("*", () => {
      throw new Error("bad hook");
    });
    bus.on("*", (event) => after.push(event.type));
    expect(() => river.append({ thread: "self", kind: "note", source: "body", text: "n" })).not.toThrow();
    expect(after).toEqual(["row.note"]);
    expect(errors[0]).toContain("bad hook");
  });

  it("a hook cannot change the recorded row", () => {
    const { bus, river } = setup();
    bus.on("*", (event) => {
      (event.row as { text?: string }).text = "changed";
    });
    river.append({ thread: "self", kind: "note", source: "body", text: "kept" });
    expect(river.read({ thread: "self" })[0]?.text).toBe("kept");
  });

  it("sees the scanned row when observing outside the secret guard, never the secret", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");
    const bus = createEventBus({ onError: () => {} });
    const seen: string[] = [];
    bus.on("*", (event) => seen.push(event.row.text ?? ""));
    const river = observeRiver(guardRiver(new MemoryRiver({ nowMs: () => NOW }), createSecretScanner()), bus, "live");
    river.append({ thread: "self", kind: "note", source: "body", text: `key ${secret}` });
    expect(seen.join(" ")).not.toContain(secret);
  });

  it("unsubscribes", () => {
    const { bus, river } = setup();
    let n = 0;
    const off = bus.on("*", () => (n += 1));
    off();
    river.append({ thread: "self", kind: "note", source: "body", text: "n" });
    expect(n).toBe(0);
  });
});

describe("JSONL exporter", () => {
  it("writes type, seq, time, thread and purpose only: no text and no data", () => {
    const dir = mkdtempSync(join(tmpdir(), "natalis-events-"));
    try {
      const path = join(dir, "events.jsonl");
      const bus = createEventBus({ onError: () => {} });
      bus.on("*", jsonlExporter(path));
      const river = observeRiver(new MemoryRiver({ nowMs: () => NOW }), bus, "eval");
      river.append({ thread: "dm:owner", kind: "say", source: "self", text: "private words", data: { x: "private data" } });
      const line = JSON.parse(readFileSync(path, "utf8").trim());
      expect(Object.keys(line).sort()).toEqual(["atMs", "purpose", "seq", "thread", "type"]);
      expect(line.purpose).toBe("eval");
      expect(readFileSync(path, "utf8")).not.toContain("private");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
