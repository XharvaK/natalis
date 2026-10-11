import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostsMatch, keepVaultEntry, readVault, readVaultEntry, removeVaultEntry, validVaultName, vaultNames } from "./vault.js";

// Invented fixture: a key a made-up site showed once. Built from parts so no token-shaped literal sits in the file.
const VALUE = ["fixture", "value", "for", "vault", "0123456789"].join("-");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-web-vault-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("validVaultName", () => {
  it("accepts the name rule and refuses dot names, device names and trailing dots", () => {
    expect(validVaultName("site_key.v2-prod")).toBe(true);
    expect(validVaultName("a".repeat(48))).toBe(true);
    for (const name of ["", "a".repeat(49), "has space", "slash/name", ".", "..", "CON", "nul.txt", "com1", "name."]) {
      expect(validVaultName(name), name).toBe(false);
    }
  });
});

describe("hostsMatch", () => {
  it("matches equal hosts, subdomains and a leading www. on either side", () => {
    expect(hostsMatch("example.org", "example.org")).toBe(true);
    expect(hostsMatch("api.example.org", "example.org")).toBe(true);
    expect(hostsMatch("example.org", "api.example.org")).toBe(true);
    expect(hostsMatch("www.example.org", "example.org")).toBe(true);
    expect(hostsMatch("example.org", "www.example.org")).toBe(true);
    expect(hostsMatch("example.org.", "EXAMPLE.org")).toBe(true);
  });

  it("refuses other hosts, including names that only end the same way", () => {
    expect(hostsMatch("other.example.net", "example.org")).toBe(false);
    expect(hostsMatch("evilexample.org", "example.org")).toBe(false);
    expect(hostsMatch("www.evil.org", "example.org")).toBe(false);
    expect(hostsMatch("example.org.evil.net", "example.org")).toBe(false);
  });
});

describe("the vault files", () => {
  it("keeps an entry bound to its host, reads it back and lists its name", () => {
    keepVaultEntry(dir, "site_key", { host: "example.org", value: VALUE });
    expect(readVaultEntry(dir, "site_key")).toEqual({ host: "example.org", value: VALUE });
    expect(vaultNames(dir)).toEqual(["site_key"]);
    expect(readVault(dir)).toEqual({ site_key: { host: "example.org", value: VALUE } });
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "vault", "site_key.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces an entry whole and removes it", () => {
    keepVaultEntry(dir, "site_key", { host: "example.org", value: VALUE });
    keepVaultEntry(dir, "site_key", { host: "api.example.org", value: `${VALUE}-2` });
    expect(readVaultEntry(dir, "site_key")?.host).toBe("api.example.org");
    expect(removeVaultEntry(dir, "site_key")).toBe(true);
    expect(removeVaultEntry(dir, "site_key")).toBe(false);
    expect(readVaultEntry(dir, "site_key")).toBeUndefined();
  });

  it("lists only valid entry names and never a temporary or unrelated file", () => {
    keepVaultEntry(dir, "b_key", { host: "example.org", value: VALUE });
    keepVaultEntry(dir, "a_key", { host: "example.org", value: VALUE });
    writeFileSync(join(dir, "vault", "~tmp-leftover"), "x");
    writeFileSync(join(dir, "vault", "notes.txt"), "x");
    writeFileSync(join(dir, "vault", "bad name.json"), "{}");
    expect(vaultNames(dir)).toEqual(["a_key", "b_key"]);
  });

  it("refuses a bad name when keeping, and treats a damaged entry as an error", () => {
    expect(() => keepVaultEntry(dir, "../escape", { host: "example.org", value: VALUE })).toThrow(/vault name/);
    mkdirSync(join(dir, "vault"), { recursive: true });
    writeFileSync(join(dir, "vault", "broken.json"), "not json");
    expect(() => readVault(dir)).toThrow("The vault entry broken is damaged.");
    writeFileSync(join(dir, "vault", "broken.json"), JSON.stringify({ host: "example.org" }));
    expect(() => readVaultEntry(dir, "broken")).toThrow(/damaged/);
  });
});
