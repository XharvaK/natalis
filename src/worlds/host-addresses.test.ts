import { describe, expect, it } from "vitest";
import { canonicalAddress, createHostAddresses, defaultGatewaysV4, interfaceAddresses } from "./host-addresses.js";

// /proc/net/route as Linux writes it: the default route's gateway is 192.168.1.1, in little-endian hex.
const ROUTES = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
  "eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
  "wan0\t00000000\t017100CB\t0003\t0\t0\t200\t00000000\t0\t0\t0",
].join("\n");

describe("the host's own addresses", () => {
  it("lists every interface address, IPv4 and IPv6, loopback included, without zone ids", () => {
    const list = interfaceAddresses({
      lo: [{ address: "127.0.0.1", family: "IPv4" } as never],
      eth0: [
        { address: "198.51.100.20", family: "IPv4" } as never,
        { address: "fe80::1%eth0", family: "IPv6" } as never,
        { address: "2001:db8::20", family: "IPv6" } as never,
      ],
    });
    expect(list).toEqual(["127.0.0.1", "198.51.100.20", "fe80::1", "2001:db8::20"]);
  });

  it("reads every default gateway from the kernel's route table", () => {
    expect(defaultGatewaysV4(ROUTES)).toEqual(["192.168.1.1", "203.0.113.1"]);
    expect(defaultGatewaysV4("")).toEqual([]);
  });

  it("canonicalizes the spellings of one address: IPv4-mapped, NAT64, compressed IPv6, case", () => {
    expect(canonicalAddress("203.0.113.7")).toBe("203.0.113.7");
    expect(canonicalAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(canonicalAddress("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(canonicalAddress("64:ff9b::cb00:7107")).toBe("203.0.113.7");
    expect(canonicalAddress("2001:DB8:0:0:0:0:0:20")).toBe("2001:db8::20");
    expect(canonicalAddress("fe80::1%eth0")).toBe("fe80::1");
    expect(canonicalAddress("not an address")).toBeUndefined();
  });

  it("joins the interfaces, the gateways and the public address the world sees, canonical and without repeats", async () => {
    const host = createHostAddresses({
      interfaces: () => ({ eth0: [{ address: "198.51.100.20", family: "IPv4" } as never, { address: "::ffff:198.51.100.20", family: "IPv6" } as never] }),
      routeText: () => ROUTES,
      publicIpv4: async () => "203.0.113.7",
      nowMs: () => 0,
    });
    expect(host.current()).toEqual(["198.51.100.20", "192.168.1.1", "203.0.113.1"]);
    await host.refresh();
    expect(host.current()).toEqual(["198.51.100.20", "192.168.1.1", "203.0.113.1", "203.0.113.7"]);
  });

  it("keeps the last public address when a later lookup fails, and never throws for it", async () => {
    let answer: string | undefined = "203.0.113.7";
    let now = 0;
    const host = createHostAddresses({
      interfaces: () => ({}),
      routeText: () => "",
      publicIpv4: async () => {
        if (answer === undefined) throw new Error("no network");
        return answer;
      },
      nowMs: () => now,
    });
    await host.refresh();
    answer = undefined;
    now = 60 * 60 * 1000;
    await host.refresh();
    expect(host.current()).toEqual(["203.0.113.7"]);
  });

  it("ignores a public answer that is not an IPv4 address", async () => {
    const host = createHostAddresses({ interfaces: () => ({}), routeText: () => "", publicIpv4: async () => "1.2.3.4; rm -rf /", nowMs: () => 0 });
    await host.refresh();
    expect(host.current()).toEqual([]);
  });
});

describe("a failed public lookup (AU NB-1)", () => {
  it("reports the public address unknown, logs it once per episode, and retries within a minute", async () => {
    let calls = 0;
    let now = 0;
    const lines: string[] = [];
    const host = createHostAddresses({
      interfaces: () => ({}),
      routeText: () => "",
      publicIpv4: async () => {
        calls += 1;
        throw new Error("no outside DNS");
      },
      nowMs: () => now,
      log: (line) => lines.push(line),
    });
    await host.refresh();
    expect(host.publicState()).toBe("unknown");
    await host.refresh();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("public IPv4");
    now = 61_000;
    host.current();
    await host.refresh();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("keeps the last-known address as known after a later failure", async () => {
    let fail = false;
    const host = createHostAddresses({
      interfaces: () => ({}),
      routeText: () => "",
      publicIpv4: async () => {
        if (fail) throw new Error("down");
        return "93.184.216.99";
      },
      nowMs: () => 0,
      log: () => undefined,
    });
    await host.refresh();
    fail = true;
    await host.refresh();
    expect(host.publicState()).toBe("known");
    expect(host.current()).toContain("93.184.216.99");
  });

  it("says off when the lookup is switched off, and logs that the WAN address is not walled", async () => {
    const lines: string[] = [];
    const host = createHostAddresses({ interfaces: () => ({}), routeText: () => "", lookup: "off", log: (line) => lines.push(line) });
    await host.refresh();
    expect(host.publicState()).toBe("off");
    expect(lines.join(" ")).toContain("NATALIS_PUBLIC_IP_LOOKUP=off");
  });
});
