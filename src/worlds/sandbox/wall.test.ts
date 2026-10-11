import { describe, expect, it } from "vitest";
import { PASTA_ARGS, PASTA_RESOLVER_NOTICE, routeScript, WALL_DNS, WALLED_RANGES, wallCommand, withoutPastaNotice } from "./wall.js";

describe("the pasta arguments", () => {
  it("are exactly the design's: config from the flags, IPv4 only, no host ports or gateway mapped in", () => {
    expect(PASTA_ARGS.join(" ")).toBe(
      "--config-net --quiet --ipv4-only --no-map-gw -t none -u none -T none -U none --address 192.0.2.2 --netmask 24 --gateway 192.0.2.1 --dns-forward 192.0.2.3",
    );
    expect(WALL_DNS).toBe("192.0.2.3");
  });
});

describe("the walled ranges", () => {
  it("walls the private, shared, link-local, benchmark, reserved and multicast space, and leaves the loopback out", () => {
    expect(WALLED_RANGES).toEqual([
      "0.0.0.0/8",
      "10.0.0.0/8",
      "100.64.0.0/10",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "192.0.0.0/24",
      "198.18.0.0/15",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ]);
    expect(WALLED_RANGES.some((range) => range.startsWith("127."))).toBe(false);
    expect(new Set(WALLED_RANGES).size).toBe(WALLED_RANGES.length);
  });
});

describe("the route script", () => {
  it("stops on the first failed route, then adds one unreachable route per walled range, by the full ip path", () => {
    const script = routeScript("/usr/sbin/ip");
    expect(script.startsWith("set -e; /usr/sbin/ip route add unreachable 0.0.0.0/8; ")).toBe(true);
    expect(script.endsWith("/usr/sbin/ip route add unreachable 240.0.0.0/4")).toBe(true);
    for (const range of WALLED_RANGES) {
      expect(script.split(`route add unreachable ${range}`)).toHaveLength(2);
    }
    expect(script.split("route add unreachable").length - 1).toBe(WALLED_RANGES.length);
    expect(script).not.toContain("127.");
  });

  it("quotes an ip path that holds a space or a quote, so it is one shell word", () => {
    expect(routeScript("/opt/my tools/ip")).toContain("'/opt/my tools/ip' route add unreachable 0.0.0.0/8");
    expect(routeScript("/opt/it's/ip")).toContain("'/opt/it'\\''s/ip' route add");
  });
});

describe("wallCommand", () => {
  it("runs pasta with its arguments, then the shell that routes and then execs bwrap with its arguments", () => {
    const bwrapArgs = ["--unshare-all", "--share-net", "bash", "-lc", "echo hi"];
    const command = wallCommand({ pastaPath: "/usr/bin/pasta", ipPath: "/usr/sbin/ip", bwrapPath: "/usr/bin/bwrap", bwrapArgs });
    expect(command.command).toBe("/usr/bin/pasta");
    expect(command.args).toEqual([
      ...PASTA_ARGS,
      "--",
      "/bin/sh",
      "-c",
      `${routeScript("/usr/sbin/ip")}; exec "$@"`,
      "sh",
      "/usr/bin/bwrap",
      ...bwrapArgs,
    ]);
  });
});

describe("pasta's start-up notice", () => {
  it("is taken out of the error output, and nothing else is", () => {
    expect(withoutPastaNotice(`${PASTA_RESOLVER_NOTICE}\nreal error\n`)).toBe("real error\n");
    expect(withoutPastaNotice("a line mentioning Couldn't get any nameserver address, quoted\n")).toBe(
      "a line mentioning Couldn't get any nameserver address, quoted\n",
    );
    expect(withoutPastaNotice("")).toBe("");
  });
});
