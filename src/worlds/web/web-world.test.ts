import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Receipt, World } from "../../contracts.js";
import { createSecretScanner } from "../../secrets/scanner.js";
import type { ResolveHost, WebFetchRequest, WebFetchResponse } from "./network.js";
import { checkArgs, createWebWorld, HIDDEN_TEXT, REQUEST_BODY_MAX, SHOWN_CHARS_MAX, webUrl } from "./web-world.js";
import { saveWebFile } from "./sites.js";
import { keepVaultEntry, readVaultEntry } from "./vault.js";

// Invented fixtures. Secret-shaped strings are built from parts at runtime; no token-shaped literal sits in this file.
const SECRET = ["fixture", "secret", "value", "0123456789"].join("-");
const TOKEN_SHAPED = ["sk", "Q1w2E3r4T5y6U7i8O9p0abcd"].join("-");
const NOW = Date.parse("2026-10-11T09:00:00Z");
const HOUR = 3_600_000;

// The fake name table: every name the tests use, with public addresses unless a test says otherwise.
const DNS: Record<string, string[]> = {
  "example.org": ["93.184.216.34"],
  "www.example.org": ["93.184.216.36"],
  "api.example.org": ["93.184.216.35"],
  "other.example.net": ["93.184.216.50"],
  "internal.example": ["10.1.2.3"],
  "mixed.example": ["93.184.216.60", "192.168.0.9"],
  "mapped.example": ["::ffff:10.0.0.1"],
};

const resolve: ResolveHost = async (hostname) => {
  const list = DNS[hostname];
  if (list === undefined) throw new Error("getaddrinfo ENOTFOUND");
  return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

function reply(status: number, text: string, headers: Record<string, string> = {}): WebFetchResponse {
  return {
    status,
    headers: { "content-type": "text/plain", ...headers },
    body: new TextEncoder().encode(text),
    truncated: false,
  };
}

let dir: string;
let calls: WebFetchRequest[];
let queue: Array<WebFetchResponse | Error>;
let clock: { now: number };
let scanner: ReturnType<typeof createSecretScanner>;
let world: World;

function fetchFake(request: WebFetchRequest): Promise<WebFetchResponse> {
  calls.push({ ...request, headers: { ...request.headers } });
  const next = queue.shift() ?? reply(200, "hello");
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}

function build(): void {
  scanner = createSecretScanner();
  world = createWebWorld({ dir, scanner, fetch: fetchFake, resolve, nowMs: () => clock.now });
}

async function run(args: Record<string, unknown>): Promise<Receipt> {
  const tool = world.tools()[0]!;
  return tool.run(args, {} as never);
}

/** A vault entry bound to example.org, registered with the scanner the way the world does at start. */
async function seedVault(host = "example.org"): Promise<void> {
  keepVaultEntry(dir, "site_key", { host, value: SECRET });
  await world.start(() => undefined);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "natalis-web-world-"));
  saveWebFile(dir, { sites: ["example.org"] });
  calls = [];
  queue = [];
  clock = { now: NOW };
  build();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("addresses and names", () => {
  it("refuses a name that resolves to a private address, even when one of several is public", async () => {
    const r = await run({ url: "https://internal.example/" });
    expect(r.refused?.code).toBe("non_public_address");
    const mixed = await run({ url: "https://mixed.example/" });
    expect(mixed.refused?.code).toBe("non_public_address");
    const mapped = await run({ url: "https://mapped.example/" });
    expect(mapped.refused?.code).toBe("non_public_address");
    expect(calls).toHaveLength(0);
  });

  it("refuses address literals that are not public, and the metadata address", async () => {
    for (const url of ["https://127.0.0.1/", "https://169.254.169.254/latest", "https://[::1]/", "https://100.100.100.200/"]) {
      const r = await run({ url });
      expect(r.refused?.code, url).toBe("non_public_address");
    }
    expect(calls).toHaveLength(0);
  });

  it("reads a public page, pinned to the address it checked", async () => {
    queue.push(reply(200, "Hello from the page"));
    const r = await run({ url: "https://example.org/page" });
    expect(r.ok).toBe(true);
    expect(r.data?.["outside"]).toBe(true);
    expect(r.data?.["body"]).toBe("Hello from the page");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe("https://example.org/page");
    expect(calls[0]!.address).toBe("93.184.216.34");
    expect(calls[0]!.family).toBe(4);
    expect(calls[0]!.method).toBe("GET");
  });

  it("upgrades http and drops a trailing dot on the host", async () => {
    await run({ url: "http://example.org./a" });
    expect(calls[0]!.url.protocol).toBe("https:");
    expect(calls[0]!.url.hostname).toBe("example.org");
  });

  it("refuses user names, other schemes, single-label hosts and names that do not resolve", async () => {
    for (const url of ["https://user:pw@example.org/", "ftp://example.org/", "https://intranet/", "https://nowhere.example/"]) {
      const r = await run({ url });
      expect(r.ok, url).toBe(false);
      expect(r.refused?.code, url).toMatch(/bad_url|unreachable/);
    }
    expect(calls).toHaveLength(0);
  });

  it("reads any public host with HEAD and GET, but sends no body with them", async () => {
    const head = await run({ url: "https://other.example.net/", method: "HEAD" });
    expect(head.ok).toBe(true);
    expect(calls[0]!.method).toBe("HEAD");
    const withBody = await run({ url: "https://example.org/", body: "x" });
    expect(withBody.refused?.code).toBe("bad_request");
  });
});

describe("redirects", () => {
  it("follows a redirect to a public host and checks that hop again", async () => {
    queue.push(reply(302, "", { location: "/next" }), reply(200, "arrived"));
    const r = await run({ url: "https://example.org/start" });
    expect(r.ok).toBe(true);
    expect(r.data?.["body"]).toBe("arrived");
    expect(r.data?.["redirects"]).toBe(1);
    expect(calls.map((call) => call.url.pathname)).toEqual(["/start", "/next"]);
  });

  it("refuses a redirect to a private name, and one to a private address literal", async () => {
    queue.push(reply(302, "", { location: "https://internal.example/" }));
    const named = await run({ url: "https://example.org/" });
    expect(named.refused?.code).toBe("non_public_address");
    queue.push(reply(302, "", { location: "http://10.0.0.1/" }));
    const literal = await run({ url: "https://example.org/" });
    expect(literal.refused?.code).toBe("non_public_address");
    expect(calls).toHaveLength(2);
  });

  it("upgrades a redirect to http, and refuses one to another scheme", async () => {
    queue.push(reply(301, "", { location: "http://example.org/moved" }), reply(200, "ok"));
    await run({ url: "https://example.org/" });
    expect(calls[1]!.url.protocol).toBe("https:");
    queue.push(reply(302, "", { location: "ftp://example.org/" }));
    const r = await run({ url: "https://example.org/" });
    expect(r.refused?.code).toBe("bad_redirect");
  });

  it("caps the chain at five redirects", async () => {
    for (let index = 0; index < 6; index++) queue.push(reply(302, "", { location: "/again" }));
    const r = await run({ url: "https://example.org/" });
    expect(r.refused?.code).toBe("too_many_redirects");
    expect(calls).toHaveLength(6);
  });

  it("never turns a GET into a write, even when the redirect keeps the method", async () => {
    queue.push(reply(307, "", { location: "/next" }), reply(200, "ok"));
    await run({ url: "https://example.org/" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  });

  it("refuses a write that a redirect sends to another host", async () => {
    saveWebFile(dir, { sites: ["example.org", "other.example.net"] });
    queue.push(reply(307, "", { location: "https://other.example.net/" }));
    const r = await run({ url: "https://example.org/submit", method: "POST", json: { a: 1 } });
    expect(r.refused?.code).toBe("redirect_cross_host");
    expect(calls).toHaveLength(1);
  });

  it("turns a write into a plain read on a 303, without the body", async () => {
    queue.push(reply(303, "", { location: "/done" }), reply(200, "done"));
    const r = await run({ url: "https://example.org/submit", method: "POST", json: { a: 1 } });
    expect(r.ok).toBe(true);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.body).toBeUndefined();
  });
});

describe("writes", () => {
  it("refuses a write to a host that is not listed, and names the way to add it", async () => {
    const r = await run({ url: "https://other.example.net/x", method: "POST", json: { a: 1 } });
    expect(r.ok).toBe(false);
    expect(r.refused?.code).toBe("site_not_listed");
    expect(r.refused?.reason).toContain("!sites add other.example.net");
    expect(calls).toHaveLength(0);
  });

  it("sends writes to a listed site and its subdomains", async () => {
    const r = await run({ url: "https://api.example.org/items", method: "PUT", body: "x", headers: { "x-note": "1" } });
    expect(r.ok).toBe(true);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual(new TextEncoder().encode("x"));
    expect(calls[0]!.headers["x-note"]).toBe("1");
  });

  it("sets a JSON content type for a json body", async () => {
    await run({ url: "https://example.org/items", method: "POST", json: { name: "lamp" } });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(new TextDecoder().decode(calls[0]!.body)).toBe('{"name":"lamp"}');
  });

  it("reads web.json fresh on each request, so an edit needs no restart", async () => {
    saveWebFile(dir, { sites: [] });
    expect((await run({ url: "https://example.org/x", method: "POST", body: "x" })).refused?.code).toBe("site_not_listed");
    saveWebFile(dir, { sites: ["example.org"] });
    expect((await run({ url: "https://example.org/x", method: "POST", body: "x" })).ok).toBe(true);
  });

  it("refuses a body over 32 KiB", async () => {
    const r = await run({ url: "https://example.org/x", method: "POST", body: "x".repeat(REQUEST_BODY_MAX + 1) });
    expect(r.refused?.code).toBe("bad_request");
    expect(calls).toHaveLength(0);
  });
});

describe("the vault", () => {
  it("keeps a value from a JSON reply bound to its host, hides it in the receipt and registers it", async () => {
    queue.push(reply(200, JSON.stringify({ agent: { api_key: SECRET, name: "lamp" } }), { "content-type": "application/json" }));
    const r = await run({ url: "https://example.org/login", keep: [{ path: "agent.api_key", as: "site_key" }] });
    expect(r.ok).toBe(true);
    expect(r.data?.["keptInVault"]).toEqual(["site_key"]);
    expect(String(r.data?.["body"])).toContain("[kept in your vault as site_key]");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(readVaultEntry(dir, "site_key")).toEqual({ host: "example.org", value: SECRET });
    expect(scanner.scan(SECRET).length).toBeGreaterThan(0);
  });

  it("sends a kept value by auth to its own host, and hides an echo of it", async () => {
    await seedVault();
    queue.push(reply(200, `you sent ${SECRET}`));
    const r = await run({ url: "https://example.org/me", auth: { vault: "site_key" } });
    expect(r.ok).toBe(true);
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(r.data?.["body"]).toBe(`you sent ${HIDDEN_TEXT}`);
    expect(r.data?.["hidden"]).toBe(1);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("sends the value to a www. form of its host, and to a subdomain", async () => {
    await seedVault("www.example.org");
    queue.push(reply(200, "ok"));
    await run({ url: "https://example.org/me", auth: { vault: "site_key" } });
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("refuses auth to a host other than the one the value was kept for, and sends nothing", async () => {
    await seedVault();
    const r = await run({ url: "https://other.example.net/steal", auth: { vault: "site_key" } });
    expect(r.ok).toBe(false);
    expect(r.refused?.code).toBe("vault_host_mismatch");
    expect(r.refused?.reason).toContain("kept for example.org");
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(calls).toHaveLength(0);
  });

  it("never sends a value kept for a subdomain to its parent, by auth or by a redirect", async () => {
    await seedVault("api.example.org");
    const direct = await run({ url: "https://example.org/me", auth: { vault: "site_key" } });
    expect(direct.refused?.code).toBe("vault_host_mismatch");
    expect(calls).toHaveLength(0);

    queue.push(reply(302, "", { location: "https://example.org/parent" }), reply(200, "ok"));
    await run({ url: "https://api.example.org/a", auth: { vault: "site_key" } });
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(calls[1]!.url.hostname).toBe("example.org");
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
  });

  it("drops auth on a cross-host redirect, and keeps it on a same-site redirect", async () => {
    await seedVault();
    queue.push(reply(302, "", { location: "https://other.example.net/b" }), reply(200, "ok"));
    await run({ url: "https://example.org/a", auth: { vault: "site_key" } });
    expect(calls[0]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(calls[1]!.url.hostname).toBe("other.example.net");
    expect(calls[1]!.headers["authorization"]).toBeUndefined();

    calls = [];
    queue.push(reply(302, "", { location: "https://api.example.org/c" }), reply(200, "ok"));
    await run({ url: "https://example.org/a", auth: { vault: "site_key" } });
    expect(calls[1]!.headers["authorization"]).toBe(`Bearer ${SECRET}`);
  });

  it("refuses a value in the url, a header or the body, and sends nothing", async () => {
    await seedVault();
    const inUrl = await run({ url: `https://example.org/?k=${SECRET}` });
    const inHeader = await run({ url: "https://example.org/", headers: { "x-key": SECRET } });
    const inBody = await run({ url: "https://example.org/", method: "POST", body: `key=${SECRET}` });
    for (const r of [inUrl, inHeader, inBody]) {
      expect(r.refused?.code).toBe("vault_value_in_request");
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses auth with a name that is not in the vault", async () => {
    const r = await run({ url: "https://example.org/", auth: { vault: "nothing_here" } });
    expect(r.refused?.code).toBe("vault_missing");
    expect(calls).toHaveLength(0);
  });

  it("refuses a keep of a value shorter than 8 characters, and keeps nothing from it", async () => {
    queue.push(reply(200, JSON.stringify({ code: "abc" }), { "content-type": "application/json" }));
    const r = await run({ url: "https://example.org/", keep: [{ path: "code", as: "short" }] });
    expect(r.ok).toBe(false);
    expect(r.refused?.code).toBe("value_too_short");
    expect(readVaultEntry(dir, "short")).toBeUndefined();
    expect(String(r.data?.["body"])).not.toContain("abc");
    expect(String(r.data?.["body"])).toContain("[not kept: shorter than 8 characters]");
  });

  it("says plainly when a keep path is missing, or the reply is not JSON", async () => {
    queue.push(reply(200, JSON.stringify({ a: 1 }), { "content-type": "application/json" }));
    const missing = await run({ url: "https://example.org/", keep: [{ path: "b.c", as: "gone" }] });
    expect(missing.refused?.code).toBe("keep_not_applied");
    queue.push(reply(200, "just text"));
    const text = await run({ url: "https://example.org/", keep: [{ path: "a", as: "gone" }] });
    expect(text.refused?.code).toBe("keep_not_applied");
    expect(readVaultEntry(dir, "gone")).toBeUndefined();
  });

  it("refuses every request plainly when a vault file is damaged", async () => {
    mkdirSync(join(dir, "vault"), { recursive: true });
    writeFileSync(join(dir, "vault", "broken.json"), "not json");
    const r = await run({ url: "https://example.org/" });
    expect(r.refused?.code).toBe("vault_unreadable");
    expect(calls).toHaveLength(0);
  });

  it("registers every vault value with the scanner at start", async () => {
    keepVaultEntry(dir, "site_key", { host: "example.org", value: SECRET });
    const fresh = createSecretScanner();
    const started = createWebWorld({ dir, scanner: fresh, fetch: fetchFake, resolve });
    expect(fresh.scan(SECRET)).toHaveLength(0);
    await started.start(() => undefined);
    expect(fresh.scan(SECRET).length).toBeGreaterThan(0);
  });
});

describe("replies", () => {
  it("hides credential-shaped text in the reply", async () => {
    queue.push(reply(200, `token ${TOKEN_SHAPED} end`));
    const r = await run({ url: "https://example.org/" });
    expect(r.data?.["body"]).toBe(`token ${HIDDEN_TEXT} end`);
    expect(r.data?.["hidden"]).toBe(1);
  });

  it("turns HTML into readable text with its links kept", async () => {
    queue.push(reply(200, "<html><title>Lamp</title><body><p>Hi &amp; bye</p><a href='/shop'>Shop</a></body></html>", { "content-type": "text/html" }));
    const r = await run({ url: "https://example.org/" });
    expect(r.data?.["body"]).toBe("Title: Lamp\n\nHi & bye\nShop (https://example.org/shop)");
    expect(r.data?.["bodyKind"]).toBe("html");
  });

  it("pretty-prints JSON and describes binary without showing it", async () => {
    queue.push(reply(200, '{"a":1}', { "content-type": "application/json" }));
    const json = await run({ url: "https://example.org/" });
    expect(json.data?.["body"]).toBe('{\n  "a": 1\n}');
    queue.push(reply(200, "\u0000\u0001\u0002", { "content-type": "image/png" }));
    const binary = await run({ url: "https://example.org/" });
    expect(binary.data?.["body"]).toBe("Binary reply (image/png, 3 bytes): not shown.");
  });

  it("shows at most 16,000 characters and says so", async () => {
    queue.push(reply(200, "a".repeat(SHOWN_CHARS_MAX + 4000)));
    const r = await run({ url: "https://example.org/" });
    expect(String(r.data?.["body"]).length).toBe(SHOWN_CHARS_MAX);
    expect(r.data?.["truncated"]).toBe(true);
    expect(r.summary).toContain("shown in part");
  });

  it("marks a reply the byte cap cut short", async () => {
    queue.push({ status: 200, headers: { "content-type": "text/plain" }, body: new Uint8Array(512 * 1024), truncated: true });
    const r = await run({ url: "https://example.org/" });
    expect(r.data?.["truncated"]).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("reports an error status as not ok, with the reply still shown", async () => {
    queue.push(reply(404, "no such page"));
    const r = await run({ url: "https://example.org/missing" });
    expect(r.ok).toBe(false);
    expect(r.refused).toBeUndefined();
    expect(r.data?.["body"]).toBe("no such page");
    expect(r.summary).toContain("answered 404");
  });

  it("says whether a write may have reached the site when the connection fails", async () => {
    queue.push(new Error("timeout"));
    const read = await run({ url: "https://example.org/" });
    expect(read.refused?.code).toBe("timeout");
    queue.push(new Error("timeout"));
    const write = await run({ url: "https://example.org/", method: "POST", body: "x" });
    expect(write.refused?.code).toBe("outcome_unknown");
    queue.push(new Error("socket hang up"));
    const broken = await run({ url: "https://example.org/" });
    expect(broken.refused?.code).toBe("unreachable");
  });
});

describe("ceilings and config", () => {
  it("counts requests in the hour, shows what is left, and frees the count after an hour", async () => {
    saveWebFile(dir, { sites: ["example.org"], perHour: 2 });
    const first = await run({ url: "https://example.org/1" });
    expect(first.data?.["requestsLeftThisHour"]).toBe(1);
    const second = await run({ url: "https://example.org/2" });
    expect(second.data?.["requestsLeftThisHour"]).toBe(0);
    const third = await run({ url: "https://example.org/3" });
    expect(third.refused?.code).toBe("hourly_limit");
    expect(calls).toHaveLength(2);
    clock.now += HOUR + 1;
    const later = await run({ url: "https://example.org/4" });
    expect(later.ok).toBe(true);
  });

  it("refuses every request plainly when web.json is damaged", async () => {
    writeFileSync(join(dir, "web.json"), JSON.stringify({ sites: ["example.org"], extra: 1 }));
    const r = await run({ url: "https://example.org/" });
    expect(r.refused?.code).toBe("sites_unreadable");
    expect(r.refused?.reason).toContain('Unknown field "extra"');
    expect(calls).toHaveLength(0);
    expect(world.now()).toContain("damaged");
  });

  it("reads public pages with no web.json, and lists no sites", async () => {
    rmSync(join(dir, "web.json"));
    queue.push(reply(200, "ok"));
    expect((await run({ url: "https://example.org/" })).ok).toBe(true);
    expect((await run({ url: "https://example.org/", method: "POST", body: "x" })).refused?.code).toBe("site_not_listed");
  });

  it("refuses an argument it does not know, and a body given twice", () => {
    expect(checkArgs({ url: "https://example.org/", nonsense: 1 }).ok).toBe(false);
    expect(checkArgs({ url: "https://example.org/", json: {}, body: "x" }).ok).toBe(false);
    expect(checkArgs({ url: "https://example.org/", auth: { vault: "no good" } }).ok).toBe(false);
    expect(checkArgs({ url: "https://example.org/", headers: { host: "x" } }).ok).toBe(false);
  });
});

describe("the world's surface", () => {
  it("says nothing to places: the web has no places to say things in", async () => {
    const r = await world.say("web:anywhere", "hello");
    expect(r.ok).toBe(false);
    expect(r.refused?.code).toBe("no_place");
  });

  it("describes itself and its sites, and counts requests in now()", async () => {
    expect(world.id).toBe("web");
    expect(world.about?.()).toContain("example.org");
    expect(world.now()).toBe("The web: 1 site(s) listed; vault names: none; 0 of 120 requests used in the last hour.");
  });

  it("reads plain URLs the way the design says", () => {
    expect(webUrl("http://example.org")?.protocol).toBe("https:");
    expect(webUrl("example.org/path")?.hostname).toBe("example.org");
    expect(webUrl("https://user@example.org")).toBeUndefined();
    expect(webUrl("https://localhost")).toBeUndefined();
    expect(webUrl("https://[::1]/")?.hostname).toBe("[::1]");
  });
});
