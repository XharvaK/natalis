import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILL_ME, loadEntityConfig } from "../../entity/config.js";
import { checkCommand, checkLar } from "./check.js";
import { DESIGN_FILE, newCommand, TEMPLATE_PATH } from "./new.js";

let root: string;
let out: string[];
let err: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-newcmd-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const make = (args: string[]): Promise<number> => newCommand(args, (line) => out.push(line), (line) => err.push(line));
const check = (args: string[]): Promise<number> => checkCommand(args, (line) => out.push(line), (line) => err.push(line));
const entityOf = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, "entity.json"), "utf8"));

describe("natalis new", () => {
  it("makes entity.json and DESIGN.md, and nothing else: the Lar is born on its first start", async () => {
    const dir = join(root, "juniper");
    expect(await make(["--dir", dir, "--summoner", "Sam", "--name", "Juniper", "--time-zone", "Europe/London"])).toBe(0);

    expect(readdirSync(dir).sort()).toEqual([DESIGN_FILE, "entity.json"]);
    expect(readFileSync(join(dir, DESIGN_FILE), "utf8")).toBe(readFileSync(TEMPLATE_PATH, "utf8"));
    expect(entityOf(dir)).toEqual({
      name: "Juniper",
      timeZone: "Europe/London",
      model: { baseUrl: FILL_ME, model: FILL_ME, apiKeyEnv: "JUNIPER_MODEL_KEY", contextTokens: FILL_ME },
      summoner: { alias: "Sam" },
    });
    expect(out.join("\n")).toContain("Still to fill in entity.json: model.baseUrl, model.model, model.contextTokens.");
  });

  it("writes a config that loads at once when the model is given, and names no rhythm or other preset", async () => {
    const dir = join(root, "kai-2");
    const args = ["--dir", dir, "--summoner", "Sam", "--base-url", "http://127.0.0.1:11434/v1", "--model", "local-model", "--context-tokens", "32000"];
    expect(await make(args)).toBe(0);

    const config = loadEntityConfig(dir);
    expect(config.name).toBeUndefined();
    expect(config.owner.alias).toBe("Sam");
    expect(config.model).toMatchObject({ baseUrl: "http://127.0.0.1:11434/v1", model: "local-model", contextTokens: 32000, apiKeyEnv: "KAI_2_MODEL_KEY" });
    expect(Object.keys(entityOf(dir)).sort()).toEqual(["model", "summoner", "timeZone"]);
    expect(out.join("\n")).not.toContain("Still to fill");
  });

  it("refuses a folder that is not empty, and changes nothing in it", async () => {
    const dir = join(root, "busy");
    mkdirSync(dir);
    writeFileSync(join(dir, "entity.json"), '{"keep": true}', "utf8");
    expect(await make(["--dir", dir, "--summoner", "Sam"])).toBe(1);
    expect(err.join("\n")).toContain("is not empty");
    expect(readFileSync(join(dir, "entity.json"), "utf8")).toBe('{"keep": true}');
    expect(existsSync(join(dir, DESIGN_FILE))).toBe(false);
  });

  it("asks for the summoner, and refuses a name over 40 characters or a key name that is not a variable name", async () => {
    expect(await make(["--dir", join(root, "a")])).toBe(2);
    expect(await make(["--dir", join(root, "b"), "--summoner", "Sam", "--name", "x".repeat(41)])).toBe(1);
    expect(await make(["--dir", join(root, "c"), "--summoner", "Sam", "--key-env", "my key"])).toBe(1);
    expect(await make(["--dir", join(root, "d"), "--summoner", "Sam", "--context-tokens", "lots"])).toBe(1);
    expect(existsSync(join(root, "b"))).toBe(false);
  });
});

describe("a FILL-ME blank", () => {
  it("keeps the Lar from starting, and the error names the field", async () => {
    const dir = join(root, "juniper");
    await make(["--dir", dir, "--summoner", "Sam", "--model", "some-model", "--context-tokens", "128000"]);
    expect(() => loadEntityConfig(dir)).toThrow(`entity.json still has a blank to fill: model.baseUrl is ${FILL_ME}.`);
  });
});

describe("natalis check", () => {
  it("names the blank as a fix, the default nature and the missing world as notes, and exits 1", async () => {
    const dir = join(root, "juniper");
    await make(["--dir", dir, "--summoner", "Sam"]);
    out = [];
    expect(await check(["--dir", dir])).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("fix  entity.json still has a blank to fill: model.baseUrl");
    expect(text).toContain("note nature.md: none, so the default nature is used.");
    expect(text).toContain("note No world file");
    expect(text).toContain("1 to fix.");
  });

  it("passes a filled folder, counts the nature's words, and never prints an id, a token name's value or a term", async () => {
    const dir = join(root, "juniper");
    await make(["--dir", dir, "--summoner", "Sam", "--base-url", "https://api.example.com/v1", "--model", "m", "--context-tokens", "128000"]);
    writeFileSync(join(dir, "nature.md"), `${"You are quick and bright. ".repeat(40)}\n`, "utf8");
    writeFileSync(join(dir, "privacy.json"), JSON.stringify({ terms: [{ term: "birthday party", category: "surprise plans" }], categories: ["surprise plans"] }));
    writeFileSync(join(dir, "contacts.json"), JSON.stringify({ version: 1, discord: ["123456789012345678"] }));
    writeFileSync(join(dir, "discord.json"), JSON.stringify({ tokenEnv: "JUNIPER_DISCORD_TOKEN", ownerUserId: "876543210987654321", rooms: ["111111111111111111"] }));
    writeFileSync(join(dir, "welcome.md"), "Juniper is awake.\n", "utf8");

    const lines = checkLar(dir, { JUNIPER_MODEL_KEY: "set", JUNIPER_DISCORD_TOKEN: "set" });
    expect(lines.filter((line) => line.level !== "ok")).toEqual([]);
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("nature.md: 200 words.");
    expect(text).toContain("privacy.json: 1 terms in 1 categories.");
    expect(text).toContain("discord.json: Discord, 1 rooms.");
    for (const secret of ["birthday party", "123456789012345678", "876543210987654321", "111111111111111111"]) expect(text).not.toContain(secret);
  });

  it("names a broken privacy list, contacts file or world file as a fix without quoting it", () => {
    const dir = join(root, "juniper");
    mkdirSync(dir);
    writeFileSync(join(dir, "entity.json"), JSON.stringify({ model: { baseUrl: "https://a.example/v1", model: "m", contextTokens: 1000 }, summoner: { alias: "Sam" } }));
    writeFileSync(join(dir, "privacy.json"), '{"terms": [{"term": "secret plan"', "utf8");
    writeFileSync(join(dir, "contacts.json"), JSON.stringify({ version: 1, discord: ["not-an-id"] }));
    writeFileSync(join(dir, "sandbox.json"), JSON.stringify({ network: "everywhere" }));

    const fixes = checkLar(dir, {}).filter((line) => line.level === "fix").map((line) => line.text);
    expect(fixes).toHaveLength(3);
    expect(fixes[0]).toContain("privacy.json: the file is not valid JSON. While it is broken, everything the Lar says outward is held.");
    expect(fixes[1]).toContain("contacts.json: discord[0] must be a user id");
    expect(fixes[2]).toContain("sandbox.json:");
    expect(fixes.join("\n")).not.toContain("secret plan");
  });

  it("notes a nature outside the suggested length and a key not set in this shell, without calling them faults", () => {
    const dir = join(root, "juniper");
    mkdirSync(dir);
    writeFileSync(join(dir, "entity.json"), JSON.stringify({ model: { baseUrl: "https://a.example/v1", model: "m", apiKeyEnv: "J_KEY", contextTokens: 1000 }, summoner: { alias: "Sam" } }));
    writeFileSync(join(dir, "nature.md"), "You are brief.\n", "utf8");
    const lines = checkLar(dir, {});
    expect(lines.some((line) => line.level === "fix")).toBe(false);
    expect(lines).toContainEqual({ level: "note", text: "nature.md: 3 words; the design form suggests 150 to 400." });
    expect(lines).toContainEqual({ level: "note", text: "J_KEY (the model key) is not set in this shell. A service reads it from the Lar's env file." });
  });
});
