// Where the web may connect: public addresses only. Every host name is resolved and every address checked; the
// connection is then pinned to the address that was checked, so a name cannot change its answer between the check
// and the connect. Node's https and dns only; no new dependency.

import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";

export type ResolvedAddress = { address: string; family: number };
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;

export type WebFetchRequest = {
  url: URL;
  /** The address that was checked; the connection goes here and nowhere else. */
  address: string;
  family: number;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  timeoutMs: number;
  maxBytes: number;
};

export type WebFetchResponse = { status: number; headers: Record<string, string>; body: Uint8Array; truncated: boolean };
export type WebFetch = (request: WebFetchRequest) => Promise<WebFetchResponse>;

function publicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  const c = octets[2] ?? -1;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // "this" network, private, loopback, multicast, reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT (also Alibaba's metadata address)
  if (a === 169 && b === 254) return false; // link-local, including the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** The eight 16-bit words of an IPv6 address, or null when the text is not one. */
function ipv6Words(address: string): number[] | null {
  const text = address.toLowerCase().split("%")[0] ?? "";
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const words: number[] = [];
    for (const token of part.split(":")) {
      if (token.includes(".")) {
        const octets = token.split(".").map(Number);
        if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
        words.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      } else if (!/^[0-9a-f]{1,4}$/.test(token)) {
        return null;
      } else {
        words.push(Number.parseInt(token, 16));
      }
    }
    return words;
  };
  const left = parse(halves[0] ?? "");
  const right = parse(halves[1] ?? "");
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  return omitted >= 1 ? [...left, ...new Array<number>(omitted).fill(0), ...right] : null;
}

function publicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (words === null) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = words;
  const embeddedV4 = `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`;
  if (words.every((word) => word === 0)) return false; // unspecified ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return publicIpv4(embeddedV4); // IPv4-mapped
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return false; // IPv4-compatible (deprecated)
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return publicIpv4(embeddedV4); // NAT64
  if (a === 0x64 && b === 0xff9b && c === 1) return false; // local-use NAT64
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return false; // discard-only
  if (a === 0x2001 && b === 0) return false; // Teredo
  if (a === 0x2001 && b === 2 && c === 0) return false; // benchmarking
  if (a === 0x2001 && (b & 0xfff0) === 0x10) return false; // ORCHID
  if (a === 0x2001 && (b & 0xfff0) === 0x20) return false; // ORCHIDv2
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2002) return false; // 6to4
  if ((a & 0xfe00) === 0xfc00) return false; // unique local
  if ((a & 0xffc0) === 0xfe80) return false; // link-local
  if ((a & 0xffc0) === 0xfec0) return false; // site-local (retired)
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return false; // loopback
  return true;
}

/** True only for an address a public site could answer from. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family === 6) return publicIpv6(address);
  return false;
}

/** The system resolver, every address the name has. */
export const defaultResolve: ResolveHost = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

/** A DNS lookup that always answers with the checked address, whatever name it is asked for. */
export function pinnedLookup(address: string, family: number) {
  return (_hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    const all = typeof options === "object" && options !== null && (options as { all?: unknown }).all === true;
    if (all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** The real transport: one https request, connected to the pinned address, body read up to the byte cap. */
export const defaultWebFetch: WebFetch = (request) =>
  new Promise<WebFetchResponse>((resolveFetch, rejectFetch) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      action();
    };
    const options = {
      method: request.method,
      headers: request.headers,
      agent: false,
      lookup: pinnedLookup(request.address, request.family),
    } as unknown as RequestOptions;
    const req = httpsRequest(request.url, options, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = request.maxBytes - total;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          total = request.maxBytes;
          truncated = true;
          res.destroy();
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      });
      res.on("end", () =>
        finish(() => resolveFetch({ status: res.statusCode ?? 0, headers: flattenHeaders(res.headers), body: Buffer.concat(chunks), truncated })),
      );
      res.on("close", () => {
        if (res.complete || truncated) {
          finish(() => resolveFetch({ status: res.statusCode ?? 0, headers: flattenHeaders(res.headers), body: Buffer.concat(chunks), truncated }));
        } else {
          finish(() => rejectFetch(new Error("The connection closed before the reply was complete.")));
        }
      });
      res.on("error", (error) => finish(() => rejectFetch(error)));
    });
    timer = setTimeout(() => req.destroy(new Error("timeout")), request.timeoutMs);
    req.on("error", (error) => finish(() => rejectFetch(error)));
    if (request.body !== undefined) req.end(request.body);
    else req.end();
  });
