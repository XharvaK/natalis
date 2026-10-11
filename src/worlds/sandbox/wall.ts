// The network wall for a command. In "wall" mode the command runs under pasta, which gives it a private network: the
// internet is reachable through the host, but this host's own loopback services and its local network are not. Pure:
// the argument lists and the route script. Finding and starting the programs is the sandbox world's.

/** The command's own address in its private network. 192.0.2.0/24 is a documentation range (TEST-NET-1): no real network uses it. */
export const WALL_ADDRESS = "192.0.2.2";
export const WALL_GATEWAY = "192.0.2.1";
/** The resolver the command is told to use. pasta forwards its queries to the host's own resolver. */
export const WALL_DNS = "192.0.2.3";

/**
 * The ranges the command may not reach. Each becomes an unreachable route inside the command's network, so a connect to
 * one fails at once: this host's private and shared networks, link-local, benchmark and multicast space, and the ranges
 * no route on the internet uses. 127.0.0.0/8 is not here: the command's network has its own loopback, which is not the
 * host's. The internet (every other range) stays reachable.
 */
export const WALLED_RANGES: readonly string[] = [
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
];

/**
 * The pasta arguments. --config-net sets the address, netmask and gateway below; --no-map-gw keeps the gateway address
 * from reaching the host's loopback; -t, -u, -T and -U none stop pasta from mapping any host port into the network
 * (so no host loopback port is ever reachable through it); --ipv4-only and --quiet keep the setup to IPv4.
 */
export const PASTA_ARGS: readonly string[] = [
  "--config-net",
  "--quiet",
  "--ipv4-only",
  "--no-map-gw",
  "-t",
  "none",
  "-u",
  "none",
  "-T",
  "none",
  "-U",
  "none",
  "--address",
  WALL_ADDRESS,
  "--netmask",
  "24",
  "--gateway",
  WALL_GATEWAY,
  "--dns-forward",
  WALL_DNS,
];

/** A shell word: the text as it is when it is plain, else single-quoted with its single quotes escaped. */
function shellWord(text: string): string {
  if (/^[A-Za-z0-9_./+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The route script, run as root inside the command's network before bwrap drops everything. `set -e` makes a failed
 * route stop the script, so the command never runs without the wall. The ip program is named by its full path.
 */
export function routeScript(ipPath: string): string {
  const ip = shellWord(ipPath);
  return ["set -e", ...WALLED_RANGES.map((range) => `${ip} route add unreachable ${range}`)].join("; ");
}

/**
 * The program and argument list for a wall-mode run: pasta runs `sh -c '<route script>; exec "$@"'`, and the shell
 * replaces itself with bwrap, which keeps --share-net and so shares the network pasta made.
 */
export function wallCommand(input: { pastaPath: string; ipPath: string; bwrapPath: string; bwrapArgs: string[] }): {
  command: string;
  args: string[];
} {
  return {
    command: input.pastaPath,
    args: [
      ...PASTA_ARGS,
      "--",
      "/bin/sh",
      "-c",
      `${routeScript(input.ipPath)}; exec "$@"`,
      "sh",
      input.bwrapPath,
      ...input.bwrapArgs,
    ],
  };
}
