import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CEILING, loadEntityConfig, parseEntityConfig } from "./config.js";

const MINIMAL = {
  name: "Iris",
  model: { baseUrl: "http://127.0.0.1:8080/v1", model: "local-model", contextTokens: 32000 },
  owner: { alias: "owner" },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("parseEntityConfig", () => {
  it("fills the default ceiling when none is given", () => {
    const config = parseEntityConfig(MINIMAL);
    expect(config.name).toBe("Iris");
    expect(config.ceiling).toEqual(DEFAULT_CEILING);
    expect(config.ceiling).toEqual({ maxModelCalls: 24, maxToolCalls: 48 });
    expect(config.effort).toBeUndefined();
    expect(config.owner).toEqual({ alias: "owner" });
  });

  it("keeps every optional field it is given", () => {
    const config = parseEntityConfig({
      ...MINIMAL,
      timeZone: "Europe/Istanbul",
      effort: "high",
      ceiling: { maxModelCalls: 8, maxToolCalls: 16 },
      model: {
        ...MINIMAL.model,
        apiKeyEnv: "NATALIS_MODEL_KEY",
        nativeTools: false,
        effortParam: "reasoning_effort",
        timeoutMs: 60000,
      },
    });
    expect(config.timeZone).toBe("Europe/Istanbul");
    expect(config.effort).toBe("high");
    expect(config.ceiling).toEqual({ maxModelCalls: 8, maxToolCalls: 16 });
    expect(config.model.apiKeyEnv).toBe("NATALIS_MODEL_KEY");
    expect(config.model.nativeTools).toBe(false);
    expect(config.model.effortParam).toBe("reasoning_effort");
    expect(config.model.timeoutMs).toBe(60000);
  });

  it("takes the summoner under its own name, keeps reading owner, and lets the name be left out", () => {
    const { owner: _owner, ...rest } = MINIMAL;
    expect(parseEntityConfig({ ...rest, summoner: { alias: "summoner" } }).owner).toEqual({ alias: "summoner" });
    expect(parseEntityConfig(MINIMAL).owner).toEqual({ alias: "owner" });
    expect(() => parseEntityConfig({ ...MINIMAL, summoner: { alias: "summoner" } })).toThrow(/not both/);
    const { name: _name, ...unnamed } = MINIMAL;
    expect(parseEntityConfig(unnamed).name).toBeUndefined();
  });

  it("names the field that is missing", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, name: "  " })).toThrow(/name must be a non-empty text/);
    expect(() => parseEntityConfig({ ...MINIMAL, owner: undefined })).toThrow(/summoner must be an object/);
    expect(() => parseEntityConfig({ ...MINIMAL, owner: {} })).toThrow(/summoner.alias must be a non-empty text/);
  });

  it("refuses a model address that is not http or https", () => {
    const model = { ...MINIMAL.model, baseUrl: "ftp://example.invalid/v1" };
    expect(() => parseEntityConfig({ ...MINIMAL, model })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => parseEntityConfig({ ...MINIMAL, model: { ...MINIMAL.model, baseUrl: "not a url" } })).toThrow(
      /full http/,
    );
  });

  it("refuses unknown fields so a typo is loud", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, colour: "blue" })).toThrow(/Unknown field "colour"/);
    expect(() => parseEntityConfig({ ...MINIMAL, model: { ...MINIMAL.model, temperature: 0 } })).toThrow(
      /Unknown field "temperature" in model/,
    );
  });

  it("leaves the holds block out unless it is given, and keeps the honesty switch as written", () => {
    expect(parseEntityConfig(MINIMAL).holds).toBeUndefined();
    expect(parseEntityConfig({ ...MINIMAL, holds: { honesty: false } }).holds).toEqual({ honesty: false });
    expect(parseEntityConfig({ ...MINIMAL, holds: {} }).holds).toEqual({});
  });

  it("refuses a holds switch that is not true or false, and an unknown hold", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, holds: { honesty: "yes" } })).toThrow(
      /holds.honesty must be true or false/,
    );
    expect(() => parseEntityConfig({ ...MINIMAL, holds: { secrets: true } })).toThrow(/Unknown field "secrets" in holds/);
    expect(() => parseEntityConfig({ ...MINIMAL, holds: true })).toThrow(/holds must be an object/);
  });

  it("refuses an effort it does not know", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, effort: "max" })).toThrow(/effort must be one of/);
  });

  it("refuses counts that are not positive whole numbers", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, model: { ...MINIMAL.model, contextTokens: 0 } })).toThrow(
      /model.contextTokens must be a whole number/,
    );
    expect(() => parseEntityConfig({ ...MINIMAL, ceiling: { maxToolCalls: 2.5 } })).toThrow(
      /ceiling.maxToolCalls must be a whole number/,
    );
  });

  it("refuses an apiKeyEnv that is not an environment variable name", () => {
    const model = { ...MINIMAL.model, apiKeyEnv: "sk-live-looks-like-a-key" };
    expect(() => parseEntityConfig({ ...MINIMAL, model })).toThrow(/apiKeyEnv must be the name of an environment variable/);
  });

  it("refuses a zone the system does not know", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, timeZone: "Mars/Olympus" })).toThrow(/is not a zone this system knows/);
  });
});

describe("loadEntityConfig", () => {
  it("reads and validates entity.json in the folder", () => {
    writeFileSync(join(dir, "entity.json"), JSON.stringify(MINIMAL), "utf8");
    expect(loadEntityConfig(dir).name).toBe("Iris");
  });

  it("says plainly when the file is missing", () => {
    expect(() => loadEntityConfig(dir)).toThrow(/No entity.json found/);
  });

  it("says plainly when the file is not JSON", () => {
    writeFileSync(join(dir, "entity.json"), "{ not json", "utf8");
    expect(() => loadEntityConfig(dir)).toThrow(/entity.json is not valid JSON/);
  });
});

describe("the daily turn limit", () => {
  it("is left out unless the entity names one", () => {
    expect(parseEntityConfig(MINIMAL).limits).toBeUndefined();
  });

  it("reads a whole number of turns per day", () => {
    expect(parseEntityConfig({ ...MINIMAL, limits: { turnsPerDay: 20 } }).limits).toEqual({ turnsPerDay: 20 });
  });

  it("refuses a limit that is not a whole number of at least one, and names the field", () => {
    for (const turnsPerDay of [0, -3, 1.5, "20", null]) {
      expect(() => parseEntityConfig({ ...MINIMAL, limits: { turnsPerDay } })).toThrow(/limits\.turnsPerDay/);
    }
  });

  it("refuses an unknown field in the limits block", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, limits: { perHour: 3 } })).toThrow(/Unknown field "perHour" in limits/);
  });

  it("refuses limits that are not an object", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, limits: 20 })).toThrow(/limits must be an object/);
  });
});

describe("model.vision", () => {
  const model = { baseUrl: "http://127.0.0.1:9/v1", model: "seeing", contextTokens: 32_000 };

  it("is off unless the model block says true, and says so plainly when it is not true or false", () => {
    expect(parseEntityConfig({ model, summoner: { alias: "owner" } }).model.vision).toBeUndefined();
    expect(parseEntityConfig({ model: { ...model, vision: true }, summoner: { alias: "owner" } }).model.vision).toBe(true);
    expect(() => parseEntityConfig({ model: { ...model, vision: "yes" }, summoner: { alias: "owner" } })).toThrow("model.vision must be true or false.");
  });
});
