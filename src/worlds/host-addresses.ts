// The host's own addresses: every interface address, every default gateway, and the public IPv4 address the internet
// sees (the router's, behind NAT). The sandbox wall and the web gate refuse them, because a static range list cannot
// know them: a connect to any of them reaches this host's services or, through a NAT hairpin, its local network.

import { readFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

type Interfaces = ReturnType<typeof networkInterfaces>;

/** What the wall and the web gate ask for: the addresses now, and a refresh of the public one. */
export type HostAddresses = {
  /** Canonical addresses, without repeats. Read when a command or request runs. */
  current(): string[];
  /** Looks the public address up again. Never rejects: a failed lookup keeps the last answer. */
  refresh(): Promise<void>;
};

/** Every interface address, loopback included, with any IPv6 zone id taken off. */
export function interfaceAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) out.push(entry.address.replace(/%.*$/, ""));
  }
  return out;
}

/** The gateway of every default route in /proc/net/route (IPv4; the kernel writes each address little-endian hex). */
export function defaultGatewaysV4(routeText: string): string[] {
  const out: string[] = [];
  for (const line of routeText.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[1] !== "00000000" || !/^[0-9A-Fa-f]{8}$/.test(fields[2]!)) continue;
    const hex = fields[2]!;
    const octets = [6, 4, 2, 0].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const address = octets.join(".");
    if (address !== "0.0.0.0") out.push(address);
  }
  return out;
}

/** One spelling per address: IPv4 dotted, IPv4-mapped and NAT64 IPv6 as their IPv4, other IPv6 compressed lower case. */
export function canonicalAddress(text: string): string | undefined {
  const bare = text.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return bare.split(".").map(Number).join(".");
  if (family !== 6) return undefined;
  let host: string;
  try {
    host = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const embedded = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (embedded) {
    const high = parseInt(embedded[1]!, 16);
    const low = parseInt(embedded[2]!, 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return host;
}

/** The public IPv4 address the internet sees for this host, asked of OpenDNS's own resolvers. */
export async function lookupPublicIpv4(timeoutMs = 2_000): Promise<string | undefined> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  resolver.setServers(["208.67.222.222", "208.67.220.220"]);
  const answers = await resolver.resolve4("myip.opendns.com");
  return answers[0];
}

function readRoutes(): string {
  try {
    return readFileSync("/proc/net/route", "utf8");
  } catch {
    return "";
  }
}

/** How long a public answer is trusted before current() starts a fresh lookup in the background. */
const PUBLIC_REFRESH_MS = 10 * 60 * 1000;

export function createHostAddresses(
  deps: {
    interfaces?: () => Interfaces;
    routeText?: () => string;
    publicIpv4?: () => Promise<string | undefined>;
    nowMs?: () => number;
  } = {},
): HostAddresses {
  const interfaces = deps.interfaces ?? (() => networkInterfaces());
  const routeText = deps.routeText ?? readRoutes;
  // NATALIS_PUBLIC_IP_LOOKUP=off skips the outside lookup (tests; hosts with no outside DNS). Interfaces and gateways stay.
  const publicIpv4 =
    deps.publicIpv4 ?? (process.env["NATALIS_PUBLIC_IP_LOOKUP"] === "off" ? async () => undefined : () => lookupPublicIpv4());
  const nowMs = deps.nowMs ?? Date.now;
  let publicAddress: string | undefined;
  let lookedUpAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const answer = await publicIpv4();
        if (answer !== undefined && isIP(answer) === 4) publicAddress = canonicalAddress(answer);
      } catch {
        // The last answer stays. Interfaces and gateways are still walled.
      } finally {
        lookedUpAt = nowMs();
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return {
    current() {
      if (lookedUpAt !== undefined && nowMs() - lookedUpAt > PUBLIC_REFRESH_MS) void refresh();
      const all = [...interfaceAddresses(interfaces()), ...defaultGatewaysV4(routeText()), ...(publicAddress ? [publicAddress] : [])];
      const out: string[] = [];
      for (const address of all) {
        const canonical = canonicalAddress(address);
        if (canonical !== undefined && !out.includes(canonical)) out.push(canonical);
      }
      return out;
    },
    refresh,
  };
}

let shared: HostAddresses | undefined;

/** The one lookup the worlds of this process share, made on first use. */
export function sharedHostAddresses(): HostAddresses {
  shared ??= createHostAddresses();
  return shared;
}
