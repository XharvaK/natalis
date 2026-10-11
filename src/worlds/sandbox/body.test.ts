import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bodyRefusal, defaultBodyRoot, isEnvFileName, packageRootFrom } from "./body.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-body-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("finding the checkout", () => {
  it("finds the package root from a folder below it", () => {
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "dist", "worlds", "sandbox"), { recursive: true });
    expect(packageRootFrom(join(root, "dist", "worlds", "sandbox"))).toBe(root);
    expect(packageRootFrom(root)).toBe(root);
  });

  it("finds this checkout from the code's own location, whatever the entity folder is", () => {
    const found = defaultBodyRoot();
    expect(found).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(found as string, "package.json"), "utf8")) as { name?: string };
    expect(manifest.name).toBe("natalis");
  });
});

describe("env file names", () => {
  it("counts .env and anything ending in .env, in any case", () => {
    expect(isEnvFileName(".env")).toBe(true);
    expect(isEnvFileName("prod.env")).toBe(true);
    expect(isEnvFileName("Prod.ENV")).toBe(true);
  });

  it("leaves alone names that only contain env", () => {
    expect(isEnvFileName("environment.md")).toBe(false);
    expect(isEnvFileName("dotenv.js")).toBe(false);
    expect(isEnvFileName("envelope.txt")).toBe(false);
    expect(isEnvFileName("README.md")).toBe(false);
  });
});

describe("refusing the bind", () => {
  it("refuses when there is no checkout to bind, and says how to turn the body off", () => {
    const why = bodyRefusal(undefined);
    expect(why).toMatch(/could not be found/);
    expect(why).toMatch(/"body": false/);
  });

  it("refuses a checkout that holds an env file, named, with no value read from it", () => {
    writeFileSync(join(root, "staging.env"), "placeholder\n");
    const why = bodyRefusal(root);
    expect(why).toMatch(/holds staging\.env/);
    expect(why).not.toContain("placeholder");
  });

  it("refuses a checkout that holds a vault folder", () => {
    mkdirSync(join(root, "vault"));
    expect(bodyRefusal(root)).toMatch(/vault folder/);
  });

  it("refuses a folder it cannot read", () => {
    expect(bodyRefusal(join(root, "missing"))).toMatch(/could not be read/);
  });

  it("allows a plain checkout, and an env-looking name that is not an env file", () => {
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "environment.md"), "notes\n");
    expect(bodyRefusal(root)).toBeUndefined();
  });
});
