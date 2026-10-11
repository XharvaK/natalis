import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODY_BINDS, bodyRefusal, defaultBodyRoot, isEnvFileName, packageRootFrom } from "./body.js";

let root: string;
// A Lar folder beside the checkout, not inside it.
let elsewhere: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "natalis-body-"));
  elsewhere = join(root, "..", "natalis-body-lar-elsewhere");
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

describe("the allow-list", () => {
  it("names the source, docs, deploy and four top files, and nothing else of the checkout", () => {
    expect(BODY_BINDS).toEqual(["src", "docs", "deploy", "README.md", "AGENTS.md", "package.json", "LICENSE"]);
  });
});

describe("env file names", () => {
  it("counts .env, .env.* and anything ending in .env, in any case", () => {
    for (const name of [".env", ".env.local", ".ENV.production", "prod.env", "Prod.ENV"]) {
      expect(isEnvFileName(name), name).toBe(true);
    }
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
    const why = bodyRefusal(undefined, elsewhere);
    expect(why).toMatch(/could not be found/);
    expect(why).toMatch(/"body": false/);
  });

  it("refuses an allow-listed folder that holds an env file at any depth, named, with no value read from it", () => {
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "deep", ".env.local"), "placeholder\n");
    const why = bodyRefusal(root, elsewhere);
    expect(why).toMatch(/src holds \.env\.local/);
    expect(why).not.toContain("placeholder");
  });

  it("refuses an allow-listed folder that holds a vault folder at any depth", () => {
    mkdirSync(join(root, "docs", "notes", "vault"), { recursive: true });
    expect(bodyRefusal(root, elsewhere)).toMatch(/vault folder/);
  });

  it("looks only inside the allow-listed folders: an env file or vault elsewhere in the checkout does not refuse", () => {
    writeFileSync(join(root, ".env"), "placeholder\n");
    mkdirSync(join(root, "node_modules", "pkg", "vault"), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "package.json"), "{}");
    expect(bodyRefusal(root, elsewhere)).toBeUndefined();
  });

  it("refuses a Lar folder that lies inside the checkout, or is the checkout", () => {
    mkdirSync(join(root, "lar"));
    expect(bodyRefusal(root, join(root, "lar"))).toMatch(/inside/);
    expect(bodyRefusal(root, root)).toMatch(/inside/);
  });

  it("refuses a folder it cannot read", () => {
    expect(bodyRefusal(join(root, "missing"), elsewhere)).toMatch(/could not be read/);
  });

  it("allows a plain checkout with the Lar folder outside it, and an env-looking name that is not an env file", () => {
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "environment.md"), "notes\n");
    expect(bodyRefusal(root, elsewhere)).toBeUndefined();
  });
});
