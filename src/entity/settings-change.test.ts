import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EntityConfig } from "./config.js";
import {
  HIDDEN_SETTING_KEYS,
  MEMORY_TOOLS_LINE,
  SETTINGS_NOTE_MAX,
  SETTING_VALUE_MAX,
  settingsChanges,
  settingsNoteText,
  settingsView,
  VISIBLE_SETTING_KEYS,
} from "./settings-change.js";

/** An invented config with a key, headers and addresses at three depths. */
const FULL: EntityConfig = {
  name: "Iris",
  timeZone: "UTC",
  model: {
    baseUrl: "http://model.invalid/v1",
    model: "main-model",
    contextTokens: 32_000,
    apiKeyEnv: "TEST_MODEL_KEY",
    headers: { "X-Org": "secret-org" },
    fallback: {
      model: "backup-model",
      baseUrl: "http://backup.invalid/v1",
      apiKeyEnv: "BACKUP_KEY",
      headers: { "X-Backup": "secret-backup" },
      fallback: {
        model: "second-model",
        baseUrl: "http://second.invalid/v1",
        apiKeyEnv: "SECOND_KEY",
        headers: { "X-Second": "secret-second" },
      },
    },
  },
  effort: "low",
  owner: { alias: "owner" },
  worldModels: {
    domus: {
      model: "world-model",
      effort: "low",
      fallback: {
        model: "world-backup",
        baseUrl: "http://world-backup.invalid/v1",
        apiKeyEnv: "WORLD_BACKUP_KEY",
        headers: { "X-World": "secret-world" },
      },
    },
  },
};

describe("settingsView", () => {
  it("removes the hidden keys at the top level, in a world model and in nested fallbacks", () => {
    const view = settingsView(FULL);
    for (const key of HIDDEN_SETTING_KEYS) expect(view).not.toContain(`"${key}"`);
    for (const secret of [
      "model.invalid",
      "backup.invalid",
      "second.invalid",
      "world-backup.invalid",
      "TEST_MODEL_KEY",
      "BACKUP_KEY",
      "SECOND_KEY",
      "WORLD_BACKUP_KEY",
      "secret-org",
      "secret-backup",
      "secret-second",
      "secret-world",
    ]) {
      expect(view).not.toContain(secret);
    }
    // Everything else stays, at every depth.
    expect(view).toContain('"main-model"');
    expect(view).toContain('"backup-model"');
    expect(view).toContain('"second-model"');
    expect(view).toContain('"world-model"');
    expect(view).toContain('"world-backup"');
    expect(view).toContain('"alias":"owner"');
  });

  it("removes a hidden key inside an array of objects too", () => {
    const withArray = {
      ...FULL,
      tools: { read_note: "allow", odd: [{ baseUrl: "http://array.invalid/v1", name: "kept" }] },
    } as unknown as EntityConfig;
    const view = settingsView(withArray);
    expect(view).not.toContain("array.invalid");
    expect(view).toContain('"kept"');
  });

  it("does not change with the order the keys were written in", () => {
    const one: EntityConfig = {
      name: "Iris",
      model: { baseUrl: "http://model.invalid/v1", model: "main-model", contextTokens: 32_000 },
      effort: "low",
      owner: { alias: "owner" },
    };
    const other: EntityConfig = {
      effort: "low",
      owner: { alias: "owner" },
      model: { contextTokens: 32_000, model: "main-model", baseUrl: "http://model.invalid/v1" },
      name: "Iris",
    };
    expect(settingsView(other)).toBe(settingsView(one));
  });
});

describe("settingsChanges", () => {
  it("names a changed leaf, an added leaf and a removed leaf in its own format", () => {
    expect(settingsChanges(
      JSON.stringify({ worldModels: { domus: { effort: "low" } } }),
      JSON.stringify({ worldModels: { domus: { effort: "high" } } }),
    )).toEqual(['worldModels.domus.effort: "low" → "high"']);
    expect(settingsChanges(JSON.stringify({ limits: {} }), JSON.stringify({ limits: { reflectBudget: 40 } })))
      .toEqual(["limits.reflectBudget: (not set) → 40"]);
    expect(settingsChanges(JSON.stringify({ rhythm: ["09:00"] }), JSON.stringify({})))
      .toEqual(['rhythm: ["09:00"] → (not set)']);
  });

  it("lists every path in sorted order and nothing for equal texts", () => {
    expect(settingsChanges(JSON.stringify({ b: 1, a: 1 }), JSON.stringify({ c: 3, b: 2, a: 2 }))).toEqual([
      "a: 1 → 2",
      "b: 1 → 2",
      "c: (not set) → 3",
    ]);
    expect(settingsChanges(settingsView(FULL), settingsView(FULL))).toEqual([]);
    const otherAddress: EntityConfig = {
      ...FULL,
      model: { ...FULL.model, baseUrl: "http://other.invalid/v1", apiKeyEnv: "OTHER_KEY" },
    };
    expect(settingsChanges(settingsView(FULL), settingsView(otherAddress))).toEqual([]);
  });

  it("cuts a long value to the limit in code points and marks it with an ellipsis", () => {
    const long = "x".repeat(100);
    expect(settingsChanges(JSON.stringify({ k: "a" }), JSON.stringify({ k: long })))
      .toEqual([`k: "a" → "${"x".repeat(SETTING_VALUE_MAX - 1)}…`]);
    const moons = "🌙".repeat(100);
    expect(settingsChanges(JSON.stringify({ k: "a" }), JSON.stringify({ k: moons })))
      .toEqual([`k: "a" → "${"🌙".repeat(SETTING_VALUE_MAX - 1)}…`]);
  });

  it("says what changed is not known when the earlier view cannot be read", () => {
    expect(settingsChanges("not json", "{}"))
      .toEqual(["The record of your earlier settings could not be read, so what changed is not known."]);
  });
});

describe("settingsNoteText", () => {
  it("writes one line for one change", () => {
    expect(settingsNoteText(['name: "Iris" → "Iris II"']))
      .toBe('The settings you run under changed since your last start:\n- name: "Iris" → "Iris II"');
  });

  it("lists SETTINGS_NOTE_MAX changes and counts the rest", () => {
    const changes = Array.from({ length: 23 }, (_, index) => `key${index}: ${index} → ${index + 1}`);
    const lines = settingsNoteText(changes).split("\n");
    expect(lines[0]).toBe("The settings you run under changed since your last start:");
    expect(lines.slice(1, 1 + SETTINGS_NOTE_MAX)).toEqual(changes.slice(0, SETTINGS_NOTE_MAX).map((change) => `- ${change}`));
    expect(lines[1 + SETTINGS_NOTE_MAX]).toBe("- and 3 more.");
    expect(lines).toHaveLength(SETTINGS_NOTE_MAX + 2);
  });
});

describe("every entity.json key is classified for the settings view (guard)", () => {
  /** Every key named in an onlyKeys list in config.ts: the keys entity.json can carry. */
  function configKeys(): string[] {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config.ts"), "utf8");
    const keys = new Set<string>();
    for (const match of source.matchAll(/onlyKeys\(\s*\w+,\s*\[([^\]]*)\]/g)) {
      for (const literal of (match[1] ?? "").matchAll(/"([^"]+)"/g)) keys.add(literal[1] ?? "");
    }
    return [...keys].sort();
  }

  it("finds the key lists it guards", () => {
    const keys = configKeys();
    expect(keys.length).toBeGreaterThan(30);
    for (const known of ["baseUrl", "apiKeyEnv", "headers", "model", "fallback"]) expect(keys).toContain(known);
  });

  it("fails when a key is neither shown nor hidden, so a new field cannot leak by default", () => {
    const unclassified = configKeys().filter((key) => !VISIBLE_SETTING_KEYS.has(key) && !HIDDEN_SETTING_KEYS.has(key));
    expect(unclassified).toEqual([]);
  });

  it("never shows a key whose name looks like an address, a key, a token or a secret", () => {
    const secretLike = /url|key|token|secret|password|auth|header|cookie|credential/i;
    // contextTokens is a size, not a token: the one known name that matches and is safe to show.
    const shown = [...VISIBLE_SETTING_KEYS].filter((key) => key !== "contextTokens" && secretLike.test(key));
    expect(shown).toEqual([]);
    for (const key of HIDDEN_SETTING_KEYS) expect(VISIBLE_SETTING_KEYS.has(key)).toBe(false);
  });
});

describe("memory tools line (one time, when reflection turns on)", () => {
  it("adds one factual line when limits.reflectBudget goes from not set to a value", () => {
    const text = settingsNoteText(["limits.reflectBudget: (not set) → 6"]);
    expect(text.endsWith(`\n${MEMORY_TOOLS_LINE}`)).toBe(true);
    for (const tool of ["mark", "record_fact", "close_fact", "link_notes", "record_observation"]) {
      expect(MEMORY_TOOLS_LINE).toContain(tool);
    }
  });
  it("leaves the note unchanged for other changes and for a later budget change", () => {
    expect(settingsNoteText(['name: "Iris" → "Iris II"'])).not.toContain(MEMORY_TOOLS_LINE);
    expect(settingsNoteText(["limits.reflectBudget: 6 → 8"])).not.toContain(MEMORY_TOOLS_LINE);
  });
});
