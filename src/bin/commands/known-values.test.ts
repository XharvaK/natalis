import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityConfig } from "../../entity/config.js";
import { heldValues, knownValueList, otherThanHelper } from "./known-values.js";

// Values built from parts at run time; the variable names are invented.
const MODEL_KEY = ["model", "key", "0123456789"].join("-");
const BOT_TOKEN = ["bot", "token", "9876543210"].join("-");
const HELPER_TOKEN = ["helper", "token", "5555555555"].join("-");
const STUDIO_TOKEN = ["studio", "token", "6666666666"].join("-");
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

  it("reads the key of a backup on another service, in the main chain or a world's", () => {
    const OTHER_KEY = ["other", "key", "2222222222"].join("-");
    const WORLD_KEY = ["world", "key", "3333333333"].join("-");
    const config: EntityConfig = {
      ...CONFIG,
      model: { ...CONFIG.model, fallback: { model: "b", baseUrl: "http://127.0.0.1:8/v1", apiKeyEnv: "TEST_OTHER_KEY" } },
      worldModels: { game: { model: "g", fallback: { model: "gb", baseUrl: "http://127.0.0.1:7/v1", apiKeyEnv: "TEST_WORLD_KEY" } } },
    };
    const held = heldValues(dir, config, { env: { TEST_MODEL_KEY: MODEL_KEY, TEST_OTHER_KEY: OTHER_KEY, TEST_WORLD_KEY: WORLD_KEY } });

    expect(held.otherModels).toEqual([OTHER_KEY, WORLD_KEY]);
    expect(knownValueList(held)).toEqual([MODEL_KEY, OTHER_KEY, WORLD_KEY]);
  });

  it("reads the embeddings key by its variable name, so the scanner holds it like a model key", () => {
    const EMBEDDINGS_KEY = ["embed", "key", "4444444444"].join("-");
    const config: EntityConfig = {
      ...CONFIG,
      embeddings: {
        baseUrl: "http://127.0.0.1:6/v1",
        model: "small-embed",
        apiKeyEnv: "TEST_EMBEDDINGS_KEY",
      },
    };
    const held = heldValues(dir, config, { env: { TEST_MODEL_KEY: MODEL_KEY, TEST_EMBEDDINGS_KEY: EMBEDDINGS_KEY } });

    expect(held.embeddings).toBe(EMBEDDINGS_KEY);
    expect(knownValueList(held)).toEqual([MODEL_KEY, EMBEDDINGS_KEY]);
  });

  it("leaves out an embeddings key that is not set, or set to nothing", () => {
    const config: EntityConfig = {
      ...CONFIG,
      embeddings: { baseUrl: "http://127.0.0.1:6/v1", model: "small-embed", apiKeyEnv: "TEST_EMBEDDINGS_KEY" },
    };

    expect(heldValues(dir, config, { env: { TEST_MODEL_KEY: MODEL_KEY } }).embeddings).toBeUndefined();
    expect(heldValues(dir, config, { env: { TEST_MODEL_KEY: MODEL_KEY, TEST_EMBEDDINGS_KEY: "" } }).embeddings).toBeUndefined();
  });

  it("leaves out a variable that is not set, or set to nothing, and a key too short to be one", () => {
    const held = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: "short", TEST_BOT_TOKEN: "" } });

    expect(held.model).toBeUndefined();
    expect(held.discord).toBeUndefined();
    expect(held.domus).toBeUndefined();
  });

  it("reads the studio's token only when kantus.json is there and its variable is set", () => {
    expect(heldValues(dir, CONFIG, { env: { TEST_STUDIO_TOKEN: STUDIO_TOKEN } }).kantus).toBeUndefined();

    writeFileSync(join(dir, "kantus.json"), JSON.stringify({ tokenEnv: "TEST_STUDIO_TOKEN" }));
    const held = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: MODEL_KEY, TEST_STUDIO_TOKEN: STUDIO_TOKEN } });
    expect(held).toEqual({ model: MODEL_KEY, kantus: STUDIO_TOKEN, vault: [] });
    expect(knownValueList(held)).toEqual([MODEL_KEY, STUDIO_TOKEN]);

    const empty = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: MODEL_KEY, TEST_STUDIO_TOKEN: "" } });
    expect(empty.kantus).toBeUndefined();
    expect(knownValueList(empty)).toEqual([MODEL_KEY]);
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

describe("the tokens the helper's token must differ from", () => {
  it("includes the model key, the bot token and every web vault value, never the helper's own", () => {
    mkdirSync(join(dir, "vault"));
    writeFileSync(join(dir, "vault", "site.json"), JSON.stringify({ host: "example.org", value: VAULT_VALUE }));
    const held = heldValues(dir, CONFIG, { env: { TEST_MODEL_KEY: MODEL_KEY, TEST_BOT_TOKEN: BOT_TOKEN, TEST_HELPER_TOKEN: HELPER_TOKEN } });

    expect(otherThanHelper(dir, CONFIG, held)).toEqual([MODEL_KEY, BOT_TOKEN, VAULT_VALUE]);
  });

  it("keeps every token but the one being checked: the studio's token for the helper, the helper's for the studio", () => {
    writeFileSync(join(dir, "kantus.json"), JSON.stringify({ tokenEnv: "TEST_STUDIO_TOKEN" }));
    const held = heldValues(dir, CONFIG, {
      env: { TEST_MODEL_KEY: MODEL_KEY, TEST_BOT_TOKEN: BOT_TOKEN, TEST_HELPER_TOKEN: HELPER_TOKEN, TEST_STUDIO_TOKEN: STUDIO_TOKEN },
    });

    // The Domus helper's token is checked against the studio's, and the studio's against the Domus helper's.
    expect(otherThanHelper(dir, CONFIG, held, "domus")).toEqual([MODEL_KEY, BOT_TOKEN, STUDIO_TOKEN]);
    expect(otherThanHelper(dir, CONFIG, held, "kantus")).toEqual([MODEL_KEY, BOT_TOKEN, HELPER_TOKEN]);
  });
});
