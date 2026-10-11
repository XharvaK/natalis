import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWebFile, normalizeHost, parseWebFile, saveWebFile, siteListed, WEB_PER_HOUR_DEFAULT } from "./sites.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-web-sites-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("normalizeHost", () => {
  it("lowercases, drops trailing dots and accepts bare names", () => {
    expect(normalizeHost(" Example.ORG. ")).toBe("example.org");
    expect(normalizeHost("api.example.org")).toBe("api.example.org");
  });

  it("refuses single labels, addresses, URLs and malformed names", () => {
    for (const text of ["localhost", "93.184.216.34", "https://example.org", "example.org/path", "a_b.example", "-x.example", ""]) {
      expect(normalizeHost(text), text).toBeUndefined();
    }
  });
});

describe("siteListed", () => {
  it("lists a host that equals an entry or ends with a dot and the entry", () => {
    expect(siteListed("example.org", ["example.org"])).toBe(true);
    expect(siteListed("api.example.org.", ["example.org"])).toBe(true);
    expect(siteListed("evilexample.org", ["example.org"])).toBe(false);
    expect(siteListed("example.org.evil.net", ["example.org"])).toBe(false);
    expect(siteListed("example.org", [])).toBe(false);
  });
});

describe("parseWebFile", () => {
  it("reads sites and the hourly ceiling, with the default ceiling when none is given", () => {
    expect(parseWebFile({ sites: ["example.org"], perHour: 30 })).toEqual({ sites: ["example.org"], perHour: 30 });
    expect(parseWebFile({})).toEqual({ sites: [], perHour: WEB_PER_HOUR_DEFAULT });
  });

  it("refuses unknown fields, bad hosts, repeated hosts and a bad ceiling", () => {
    expect(() => parseWebFile({ sites: [], extra: true })).toThrow(/Unknown field "extra"/);
    expect(() => parseWebFile({ sites: ["Example.org"] })).toThrow(/not a host name in lowercase/);
    expect(() => parseWebFile({ sites: ["93.184.216.34"] })).toThrow(/not a host name/);
    expect(() => parseWebFile({ sites: ["example.org", "example.org"] })).toThrow(/listed twice/);
    expect(() => parseWebFile({ sites: "example.org" })).toThrow(/sites must be a list/);
    expect(() => parseWebFile({ perHour: 0 })).toThrow(/perHour must be a whole number/);
    expect(() => parseWebFile({ perHour: 1.5 })).toThrow(/perHour must be a whole number/);
    expect(() => parseWebFile({ perHour: "120" })).toThrow(/perHour must be a whole number/);
    expect(() => parseWebFile([])).toThrow(/must be an object/);
  });
});

describe("loadWebFile and saveWebFile", () => {
  it("is undefined when there is no web.json", () => {
    expect(loadWebFile(dir)).toBeUndefined();
  });

  it("reads what was saved, and refuses a damaged file plainly", () => {
    saveWebFile(dir, { sites: ["example.org"], perHour: 60 });
    expect(loadWebFile(dir)).toEqual({ sites: ["example.org"], perHour: 60 });
    writeFileSync(join(dir, "web.json"), "{ not json");
    expect(() => loadWebFile(dir)).toThrow("web.json is not valid JSON.");
    writeFileSync(join(dir, "web.json"), JSON.stringify({ sites: ["bad host"] }));
    expect(() => loadWebFile(dir)).toThrow(/not a host name/);
  });

  it("writes without a ceiling when none is given", () => {
    saveWebFile(dir, { sites: ["example.org"] });
    expect(loadWebFile(dir)).toEqual({ sites: ["example.org"], perHour: WEB_PER_HOUR_DEFAULT });
  });
});
