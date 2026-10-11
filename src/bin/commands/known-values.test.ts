import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityConfig } from "../../entity/config.js";
import { heldValues, knownValueList } from "./known-values.js";

// Values built from parts at run time; the variable names are invented.
const MODEL_KEY = ["model", "key", "0123456789"].join("-");
const BOT_TOKEN = ["bot", "token", "9876543210"].join("-");
const HELPER_TOKEN = ["helper", "token", "5555555555"].join("-");
const VAULT_VALUE = ["vault", "value", "1111111111"].join("-");

const CONFIG: EntityConfig = {
  model: { baseUrl: "http://127.0.0.1:9/v1", model: "scripted", apiKeyEnv: "TEST_MODEL_KEY", contextTokens: 32_000 },
  owner: { alias: "summoner" },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-known-"));
  writeFileSync(join(dir, "discord.json"), JSON.stringify({ tokenEnv: "TEST_BOT_TOKEN", ownerUserId: "1234", rooms: [] }));
  writeFileSync(join(dir, "domus.json"), JSON.stringify({ tokenEnv: "TEST_HELPER_TOKEN" }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("heldValues", () => {
  it("reads the model key and the two world tokens by their variable names", () => {
    const held = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: MODEL_KEY, TEST_BOT_TOKEN: BOT_TOKEN, TEST_HELPER_TOKEN: HELPER_TOKEN } });

    expect(held).toEqual({ model: MODEL_KEY, discord: BOT_TOKEN, domus: HELPER_TOKEN, vault: [] });
  });

  it("leaves out a variable that is not set, or set to nothing, and a key too short to be one", () => {
    const held = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: "short", TEST_BOT_TOKEN: "" } });

    expect(held.model).toBeUndefined();
    expect(held.discord).toBeUndefined();
    expect(held.domus).toBeUndefined();
  });

  it("reads the web vault's values only when asked, and keeps only values the scanner accepts", () => {
    mkdirSync(join(dir, "vault"));
    writeFileSync(join(dir, "vault", "site.json"), JSON.stringify({ host: "example.org", value: VAULT_VALUE }));
    writeFileSync(join(dir, "vault", "tiny.json"), JSON.stringify({ host: "example.org", value: "tiny" }));

    expect(heldValues(dir, CONFIG, { env: {} }).vault).toEqual([]);
    expect(heldValues(dir, CONFIG, { env: {}, vault: true }).vault).toEqual([VAULT_VALUE]);
  });

  it("lists every held value, vault values included, for the scanner", () => {
    const held = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: MODEL_KEY }, vault: true });
    mkdirSync(join(dir, "vault"));
    writeFileSync(join(dir, "vault", "site.json"), JSON.stringify({ host: "example.org", value: VAULT_VALUE }));
    const withVault = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: MODEL_KEY }, vault: true });

    expect(knownValueList(held)).toEqual([MODEL_KEY]);
    expect(knownValueList(withVault)).toEqual([MODEL_KEY, VAULT_VALUE]);
  });
});
