import { describe, expect, it } from "vitest";
import { isPublicAddress, pinnedLookup } from "./network.js";

describe("isPublicAddress", () => {
  it("accepts ordinary public IPv4 addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("172.15.255.255")).toBe(true);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });

  it("refuses private, loopback, link-local, carrier-grade NAT, multicast and reserved IPv4", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "127.0.0.1",
      "169.254.169.254",
      "100.100.100.200",
      "100.64.0.1",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "198.18.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses IPv6 loopback, unspecified, unique-local, link-local, multicast and documentation addresses", () => {
    for (const address of [
      "::",
      "::1",
      "fc00::1",
      "fd00:ec2::254",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "2001:db8::1",
      "2002::1",
      "2001::1",
      "100::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("checks the address inside IPv4-mapped and NAT64 IPv6 addresses", () => {
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
    expect(isPublicAddress("64:ff9b::a00:1")).toBe(false);
    expect(isPublicAddress("64:ff9b::5db8:d822")).toBe(true);
  });

  it("accepts a public IPv6 address and refuses text that is not an address", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("example.org")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
    expect(isPublicAddress("1.2.3")).toBe(false);
  });
});

describe("pinnedLookup", () => {
  it("answers with the checked address whatever name is asked for", () => {
    const lookup = pinnedLookup("93.184.216.34", 4);
    const seen: unknown[] = [];
    lookup("anything.example", {}, (...args: unknown[]) => seen.push(args));
    lookup("other.example", { all: true }, (...args: unknown[]) => seen.push(args));
    expect(seen[0]).toEqual([null, "93.184.216.34", 4]);
    expect(seen[1]).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });
});
