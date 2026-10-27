import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CEILING, DEFAULT_LIFE_VIEW_CHARS, DEFAULT_RHYTHM, loadEntityConfig, parseEntityConfig } from "./config.js";

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
  it("reads an optional price per million tokens for the model and its backup, and none by default", () => {
    expect(parseEntityConfig(MINIMAL).model.price).toBeUndefined();
    const priced = parseEntityConfig({
      ...MINIMAL,
      model: {
        ...MINIMAL.model,
        price: { inputPerMillion: 2, outputPerMillion: 4 },
        fallback: { model: "backup-model", price: { inputPerMillion: 1, outputPerMillion: 1.5 } },
      },
    });
    expect(priced.model.price).toEqual({ inputPerMillion: 2, outputPerMillion: 4 });
    expect(priced.model.fallback?.price).toEqual({ inputPerMillion: 1, outputPerMillion: 1.5 });
    expect(() =>
      parseEntityConfig({ ...MINIMAL, model: { ...MINIMAL.model, price: { inputPerMillion: -1, outputPerMillion: 4 } } }),
    ).toThrow(/inputPerMillion must be a number, 0 or more/);
  });

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

describe("the reflection budget", () => {
  it("is off unless limits.reflectBudget is set, and refuses a value that is not a whole number of at least one", () => {
    expect(parseEntityConfig(MINIMAL).limits?.reflectBudget).toBeUndefined();
    expect(parseEntityConfig({ ...MINIMAL, limits: { reflectBudget: 6 } }).limits).toEqual({ reflectBudget: 6 });
    expect(parseEntityConfig({ ...MINIMAL, limits: { turnsPerDay: 20, reflectBudget: 6 } }).limits).toEqual({
      turnsPerDay: 20,
      reflectBudget: 6,
    });
    for (const reflectBudget of [0, -1, 1.5, "6", null]) {
      expect(() => parseEntityConfig({ ...MINIMAL, limits: { reflectBudget } })).toThrow(/limits\.reflectBudget/);
    }
  });
});

describe("the life view size", () => {
  it("defaults to 20,000 characters and reads limits.lifeViewChars as a whole number of at least one", () => {
    expect(DEFAULT_LIFE_VIEW_CHARS).toBe(20_000);
    expect(parseEntityConfig(MINIMAL).limits?.lifeViewChars).toBeUndefined();
    expect(parseEntityConfig({ ...MINIMAL, limits: { lifeViewChars: 5_000 } }).limits).toEqual({ lifeViewChars: 5_000 });
    expect(parseEntityConfig({ ...MINIMAL, limits: { lifeWarnChars: 40_000, lifeViewChars: 5_000 } }).limits).toEqual({
      lifeWarnChars: 40_000,
      lifeViewChars: 5_000,
    });
    for (const lifeViewChars of [0, -1, 1.5, "5000", null]) {
      expect(() => parseEntityConfig({ ...MINIMAL, limits: { lifeViewChars } })).toThrow(/limits\.lifeViewChars/);
    }
  });
});

describe("model.vision", () => {
  const model = { baseUrl: ["http://", ["127", "0", "0", "1"].join("."), ":9/v1"].join(""), model: "seeing", contextTokens: 32_000 };

  it("is off unless the model block says true, and says so plainly when it is not true or false", () => {
    expect(parseEntityConfig({ model, summoner: { alias: "owner" } }).model.vision).toBeUndefined();
    expect(parseEntityConfig({ model: { ...model, vision: true }, summoner: { alias: "owner" } }).model.vision).toBe(true);
    expect(() => parseEntityConfig({ model: { ...model, vision: "yes" }, summoner: { alias: "owner" } })).toThrow("model.vision must be true or false.");
  });
});

describe("model.fallback, the backup model", () => {
  const model = { baseUrl: ["http://", ["127", "0", "0", "1"].join("."), ":9/v1"].join(""), model: "main", contextTokens: 32_000 };
  const parse = (fallback: unknown) => parseEntityConfig({ model: { ...model, fallback }, summoner: { alias: "owner" } });

  it("is off unless the model block names one, and keeps its name, effort field and vision switch", () => {
    expect(parseEntityConfig({ model, summoner: { alias: "owner" } }).model.fallback).toBeUndefined();
    expect(parse({ model: "backup" }).model.fallback).toEqual({ model: "backup" });
    expect(parse({ model: "backup", effortParam: null, vision: true }).model.fallback).toEqual({
      model: "backup",
      effortParam: null,
      vision: true,
    });
    expect(parse({ model: "backup", effortParam: "reasoning_effort" }).model.fallback?.effortParam).toBe("reasoning_effort");
  });

  it("refuses an unknown field", () => {
    expect(() => parse({ model: "backup", nativeTools: false })).toThrow(/Unknown field "nativeTools" in model.fallback/);
    expect(() => parse({ model: "backup", timeoutMs: 5 })).toThrow(/Unknown field "timeoutMs" in model.fallback/);
  });

  it("takes a service of its own and a backup of its own, and names the nested field in its errors", () => {
    const other = ["https://", "other.example.test", "/v1"].join("");
    const parsed = parse({
      model: "backup",
      baseUrl: other,
      apiKeyEnv: "OTHER_KEY",
      headers: { "x-session": "s-1" },
      fallback: { model: "last", effort: "low" },
    }).model.fallback;
    expect(parsed).toEqual({
      model: "backup",
      baseUrl: other,
      apiKeyEnv: "OTHER_KEY",
      headers: { "x-session": "s-1" },
      fallback: { model: "last", effort: "low" },
    });
    expect(() => parse({ model: "backup", baseUrl: "ftp://x" })).toThrow("model.fallback.baseUrl must start with http:// or https://.");
    expect(() => parse({ model: "backup", apiKeyEnv: "not a name" })).toThrow(/model.fallback.apiKeyEnv must be the name/);
    expect(() => parse({ model: "backup", headers: { authorization: "x" } })).toThrow(/must not set authorization/);
    expect(() => parse({ model: "backup", fallback: { model: 3 } })).toThrow("model.fallback.fallback.model must be a non-empty text.");
    expect(() => parse({ model: "backup", api: "responses", cacheMarks: true })).toThrow(/model.fallback.cacheMarks is for the chat protocol only/);
  });

  it("gives a world model a backup chain of its own", () => {
    const config = parseEntityConfig({
      model,
      summoner: { alias: "owner" },
      worldModels: { game: { model: "fast", effort: "low", fallback: { model: "fast-elsewhere", baseUrl: model.baseUrl, effort: "low" } } },
    });
    expect(config.worldModels?.["game"]?.fallback).toEqual({ model: "fast-elsewhere", baseUrl: model.baseUrl, effort: "low" });
    expect(() =>
      parseEntityConfig({ model, summoner: { alias: "owner" }, worldModels: { game: { model: "fast", fallback: {} } } }),
    ).toThrow("worldModels.game.fallback.model must be a non-empty text.");
  });

  it("refuses a model name that is not text, and says which field", () => {
    expect(() => parse({ model: 7 })).toThrow("model.fallback.model must be a non-empty text.");
    expect(() => parse({})).toThrow("model.fallback.model must be a non-empty text.");
    expect(() => parse({ model: "  " })).toThrow("model.fallback.model must be a non-empty text.");
  });

  it("takes the backup's own effort and context size, and refuses values outside their rules", () => {
    expect(parse({ model: "backup", effort: "xhigh", contextTokens: 64_000 }).model.fallback).toEqual({
      model: "backup",
      effort: "xhigh",
      contextTokens: 64_000,
    });
    expect(() => parse({ model: "backup", effort: "max" })).toThrow("model.fallback.effort must be one of low, medium, high, xhigh.");
    expect(() => parse({ model: "backup", contextTokens: 0 })).toThrow("model.fallback.contextTokens must be a whole number, 1 or more.");
    expect(() => parse({ model: "backup", contextTokens: "big" })).toThrow("model.fallback.contextTokens must be a whole number, 1 or more.");
  });

  it("refuses a wrong effort field or vision value, and a block that is not an object", () => {
    expect(() => parse({ model: "backup", effortParam: "effort" })).toThrow('model.fallback.effortParam must be "reasoning_effort" or null.');
    expect(() => parse({ model: "backup", vision: "yes" })).toThrow("model.fallback.vision must be true or false.");
    expect(() => parse("backup")).toThrow("model.fallback must be an object.");
  });
});

describe("rhythm", () => {
  it("is empty when entity.json leaves it out: no Lar is given preset times", () => {
    expect(parseEntityConfig(MINIMAL).rhythm).toEqual([]);
    expect(DEFAULT_RHYTHM).toEqual([]);
  });

  it("keeps the times it is given, and an empty list means none", () => {
    expect(parseEntityConfig({ ...MINIMAL, rhythm: ["07:30", "23:59"] }).rhythm).toEqual(["07:30", "23:59"]);
    expect(parseEntityConfig({ ...MINIMAL, rhythm: [] }).rhythm).toEqual([]);
  });

  it("refuses a time that is not HH:MM, and says which one", () => {
    for (const bad of ["9:00", "24:00", "12:60", "12.00", "noon", "", 900, null]) {
      expect(() => parseEntityConfig({ ...MINIMAL, rhythm: [bad] })).toThrow(/rhythm holds .* not a clock time "HH:MM"/);
    }
  });

  it("refuses a rhythm that is not a list, and a time listed twice", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, rhythm: "09:00" })).toThrow("rhythm must be a list of clock times");
    expect(() => parseEntityConfig({ ...MINIMAL, rhythm: ["09:00", "09:00"] })).toThrow("rhythm lists 09:00 more than once.");
  });
});

describe("model.cacheMarks", () => {
  const model = { baseUrl: ["http://", ["127", "0", "0", "1"].join("."), ":9/v1"].join(""), model: "main", contextTokens: 32_000 };

  it("is off unless the model block says true, on the main model and on its backup, and says so plainly when it is not true or false", () => {
    expect(parseEntityConfig({ model, summoner: { alias: "owner" } }).model.cacheMarks).toBeUndefined();
    expect(parseEntityConfig({ model: { ...model, cacheMarks: true }, summoner: { alias: "owner" } }).model.cacheMarks).toBe(true);
    expect(
      parseEntityConfig({ model: { ...model, fallback: { model: "backup", cacheMarks: true } }, summoner: { alias: "owner" } })
        .model.fallback,
    ).toEqual({ model: "backup", cacheMarks: true });
    expect(() => parseEntityConfig({ model: { ...model, cacheMarks: "yes" }, summoner: { alias: "owner" } })).toThrow(
      "model.cacheMarks must be true or false.",
    );
  });
});

describe("model.api, model.headers and model.effortMap", () => {
  const model = { baseUrl: "https://llm.example.test/v1", model: "main", contextTokens: 32_000 };
  const parse = (extra: Record<string, unknown>) =>
    parseEntityConfig({ model: { ...model, ...extra }, summoner: { alias: "owner" } }).model;

  it("keeps the protocol, the headers and the effort map, on the model and its backup", () => {
    const parsed = parse({
      api: "responses",
      headers: { "x-session": " s-1 ", "user-agent": "natalis" },
      effortMap: { xhigh: "max" },
      fallback: { model: "backup", api: "chat", effortMap: { low: "minimal" } },
    });
    expect(parsed.api).toBe("responses");
    expect(parsed.headers).toEqual({ "x-session": "s-1", "user-agent": "natalis" });
    expect(parsed.effortMap).toEqual({ xhigh: "max" });
    expect(parsed.fallback).toEqual({ model: "backup", api: "chat", effortMap: { low: "minimal" } });
  });

  it("refuses an unknown protocol, an authorization header, a bad header and an effort the entity does not know", () => {
    expect(() => parse({ api: "completions" })).toThrow('model.api must be "chat" or "responses".');
    expect(() => parse({ headers: { Authorization: "Bearer x" } })).toThrow("must not set authorization");
    expect(() => parse({ headers: { "bad name": "x" } })).toThrow("header name that is not valid");
    expect(() => parse({ headers: { "x-a": "one\ntwo" } })).toThrow("model.headers.x-a must be a non-empty text on one line.");
    expect(() => parse({ effortMap: { ultra: "max" } })).toThrow('Unknown field "ultra" in model.effortMap.');
  });

  it("refuses cache marks on the responses protocol", () => {
    expect(() => parse({ api: "responses", cacheMarks: true })).toThrow("model.cacheMarks is for the chat protocol only");
  });

  it("lets a world model name its own protocol and effort map", () => {
    const parsed = parseEntityConfig({
      model,
      summoner: { alias: "owner" },
      worldModels: { game: { model: "fast", api: "responses", effortMap: { high: "max" } } },
    });
    expect(parsed.worldModels?.["game"]).toEqual({ model: "fast", api: "responses", effortMap: { high: "max" } });
  });
});

describe("model.incremental and model.idleTimeoutMs", () => {
  const model = { baseUrl: "https://llm.example.test/v1", model: "main", contextTokens: 32_000 };
  const parse = (extra: Record<string, unknown>) =>
    parseEntityConfig({ model: { ...model, ...extra }, summoner: { alias: "owner" } }).model;
  const OLD_KEY = ["str", "eam"].join("");

  it("is off unless the model block says true, and keeps the silence limit and a backup's own setting", () => {
    expect(parse({}).incremental).toBeUndefined();
    const parsed = parse({ incremental: true, idleTimeoutMs: 120_000, fallback: { model: "backup", api: "responses", incremental: false } });
    expect(parsed.incremental).toBe(true);
    expect(parsed.idleTimeoutMs).toBe(120_000);
    expect(parsed.fallback).toEqual({ model: "backup", api: "responses", incremental: false });
  });

  it("still reads the old key name, on the model and on a backup, and the new key wins when both are given", () => {
    const parsed = parse({ [OLD_KEY]: true, idleTimeoutMs: 300_000, fallback: { model: "backup", [OLD_KEY]: false } });
    expect(parsed.incremental).toBe(true);
    expect(parsed.fallback).toEqual({ model: "backup", incremental: false });
    expect(parsed).not.toHaveProperty(OLD_KEY);
    expect(parse({ incremental: false, [OLD_KEY]: true }).incremental).toBe(false);
    expect(parse({ incremental: true, [OLD_KEY]: false, idleTimeoutMs: 1 }).incremental).toBe(true);
  });

  it("refuses incremental replies on the responses protocol, and a silence limit without them", () => {
    expect(() => parse({ api: "responses", incremental: true })).toThrow("model.incremental is for the chat protocol only");
    expect(() => parse({ api: "responses", [OLD_KEY]: true })).toThrow("model.incremental is for the chat protocol only");
    expect(() => parse({ fallback: { model: "b", api: "responses", incremental: true } })).toThrow(
      "model.fallback.incremental is for the chat protocol only",
    );
    expect(() => parse({ idleTimeoutMs: 60_000 })).toThrow("model.idleTimeoutMs only works with model.incremental true");
    expect(() => parse({ incremental: "yes" })).toThrow("model.incremental must be true or false.");
    expect(() => parse({ incremental: true, idleTimeoutMs: 0 })).toThrow("model.idleTimeoutMs must be a whole number, 1 or more.");
  });
});

describe("ceiling.wholeResultsChars", () => {
  it("is left out unless given, and kept beside the call limits when it is", () => {
    expect(parseEntityConfig(MINIMAL).ceiling).not.toHaveProperty("wholeResultsChars");
    expect(parseEntityConfig({ ...MINIMAL, ceiling: { maxModelCalls: 64, maxToolCalls: 128, wholeResultsChars: 48_000 } }).ceiling).toEqual({
      maxModelCalls: 64,
      maxToolCalls: 128,
      wholeResultsChars: 48_000,
    });
  });

  it("refuses a budget that is not a positive whole number", () => {
    expect(() => parseEntityConfig({ ...MINIMAL, ceiling: { wholeResultsChars: -1 } })).toThrow(
      "ceiling.wholeResultsChars must be a whole number, 1 or more.",
    );
  });
});
