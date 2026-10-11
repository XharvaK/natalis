import { describe, expect, it } from "vitest";
import { buildBwrapArgs, ETC_PIECES, SANDBOX_HOME, SANDBOX_PATH } from "./bwrap.js";

// Invented folder names. The entity folder is the parent of the home folder.
const ENTITY = "/var/natalis/ada";
const HOME = `${ENTITY}/home`;

const ETC = ETC_PIECES.flatMap((piece) => ["--ro-bind-try", `/etc/${piece}`, `/etc/${piece}`]);

describe("buildBwrapArgs", () => {
  it("builds the exact argument list the design lists, ending with bash -lc and the command", () => {
    expect(buildBwrapArgs({ homeDir: HOME, command: "echo hi" })).toEqual([
      "--unshare-all",
      "--share-net",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/sbin",
      "/sbin",
      "--symlink",
      "usr/lib",
      "/lib",
      "--symlink",
      "usr/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      ...ETC,
      "--bind",
      HOME,
      "/home/lar",
      "--chdir",
      "/home/lar",
      "--setenv",
      "PATH",
      "/home/lar/.local/bin:/usr/local/bin:/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/home/lar",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--setenv",
      "TERM",
      "dumb",
      "--setenv",
      "NPM_CONFIG_PREFIX",
      "/home/lar/.local",
      "bash",
      "-lc",
      "echo hi",
    ]);
  });

  it("binds only the home folder from the host, and never the entity folder, the vault or any env file", () => {
    const args = buildBwrapArgs({ homeDir: HOME, command: "true" });
    // The host side of every bind: the source named after each bind flag.
    const bindFlags = ["--bind", "--ro-bind", "--ro-bind-try"];
    const sources: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (bindFlags.includes(args[i] as string)) sources.push(args[i + 1] as string);
    }
    expect(sources.sort()).toEqual(["/usr", HOME, ...ETC_PIECES.map((piece) => `/etc/${piece}`)].sort());
    expect(sources).not.toContain(ENTITY);
    for (const forbidden of ["vault", ".env", "entity.json", "sandbox.json", "discord.json", "/root"]) {
      expect(args.some((arg) => arg.includes(forbidden))).toBe(false);
    }
    // The only /home path inside the sandbox is the Lar's own home: the bind target, the cwd and HOME.
    expect(args.filter((arg) => arg.startsWith("/home"))).toEqual([SANDBOX_HOME, SANDBOX_HOME, SANDBOX_PATH, SANDBOX_HOME, `${SANDBOX_HOME}/.local`]);
  });

  it("clears the environment before setting the five variables, and sets no others", () => {
    const args = buildBwrapArgs({ homeDir: HOME, command: "env" });
    const clear = args.indexOf("--clearenv");
    expect(clear).toBeGreaterThan(-1);
    const setenvs: Array<[string, string]> = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--setenv") setenvs.push([args[i + 1] as string, args[i + 2] as string]);
      if (args[i] === "--setenv") expect(i).toBeGreaterThan(clear);
    }
    expect(setenvs).toEqual([
      ["PATH", SANDBOX_PATH],
      ["HOME", SANDBOX_HOME],
      ["LANG", "C.UTF-8"],
      ["TERM", "dumb"],
      ["NPM_CONFIG_PREFIX", "/home/lar/.local"],
    ]);
    expect(SANDBOX_PATH).toBe("/home/lar/.local/bin:/usr/local/bin:/usr/bin:/bin");
  });

  it("passes the command as one argument, so nothing in it is split or quoted by the body", () => {
    const command = "printf '%s\\n' \"a b\"; ls -la /home/lar | head";
    const args = buildBwrapArgs({ homeDir: HOME, command });
    expect(args.slice(-3)).toEqual(["bash", "-lc", command]);
  });
});

describe("buildBwrapArgs: the body", () => {
  // An invented checkout folder, away from the entity folder.
  const CHECKOUT = "/opt/natalis-checkout";
  const ALLOWED = ["src", "docs", "deploy", "README.md", "AGENTS.md", "package.json", "LICENSE"];

  it("binds only the allow-listed names of the checkout, read-only, each at the same path under a read-only /body", () => {
    const args = buildBwrapArgs({ homeDir: HOME, command: "true", bodyDir: CHECKOUT });
    const block = ["--tmpfs", "/body", ...ALLOWED.flatMap((name) => ["--ro-bind-try", `${CHECKOUT}/${name}`, `/body/${name}`]), "--remount-ro", "/body"];
    const at = args.indexOf("--chdir");
    expect(args.slice(at - block.length, at)).toEqual(block);
    // Nothing of the checkout is bound except those names: no .git, dist, node_modules or other top-level name.
    const checkoutSources = args.filter((arg) => arg.startsWith(CHECKOUT));
    expect(checkoutSources).toEqual(ALLOWED.map((name) => `${CHECKOUT}/${name}`));
  });

  it("never binds the checkout writable", () => {
    const args = buildBwrapArgs({ homeDir: HOME, command: "true", bodyDir: CHECKOUT });
    expect(args.some((arg, index) => arg === "--bind" && args[index + 1]?.startsWith(CHECKOUT))).toBe(false);
    expect(args.some((arg, index) => arg === "--ro-bind" && args[index + 1]?.startsWith(CHECKOUT))).toBe(false);
  });

  it("adds nothing for the body when no checkout is given, and the rest of the list is unchanged", () => {
    const without = buildBwrapArgs({ homeDir: HOME, command: "true" });
    expect(without.some((arg) => arg.startsWith("/body"))).toBe(false);
    const withBody = buildBwrapArgs({ homeDir: HOME, command: "true", bodyDir: CHECKOUT });
    const block = ["--tmpfs", "/body", ...ALLOWED.flatMap((name) => ["--ro-bind-try", `${CHECKOUT}/${name}`, `/body/${name}`]), "--remount-ro", "/body"];
    const at = without.indexOf("--chdir");
    expect(withBody).toEqual([...without.slice(0, at), ...block, ...without.slice(at)]);
  });
});

describe("buildBwrapArgs: the network mode", () => {
  const RESOLV = `${ENTITY}/sandbox-network/resolv.conf`;

  it("shares the host's network by default, exactly as the host mode always did", () => {
    expect(buildBwrapArgs({ homeDir: HOME, command: "true" })).toEqual(buildBwrapArgs({ homeDir: HOME, command: "true", network: "host" }));
    expect(buildBwrapArgs({ homeDir: HOME, command: "true" })).toContain("--share-net");
  });

  it("leaves --share-net out in none mode, so the command has loopback only", () => {
    const args = buildBwrapArgs({ homeDir: HOME, command: "true", network: "none" });
    expect(args.slice(0, 3)).toEqual(["--unshare-all", "--die-with-parent", "--new-session"]);
    expect(args).not.toContain("--share-net");
    expect(args).toContain("--ro-bind-try");
    expect(args).toContain("/etc/resolv.conf");
  });

  it("keeps --share-net in wall mode, binds the resolver file in place of the host's, and never the host's resolv.conf", () => {
    const args = buildBwrapArgs({ homeDir: HOME, command: "true", network: "wall", resolvPath: RESOLV });
    expect(args.slice(0, 3)).toEqual(["--unshare-all", "--share-net", "--die-with-parent"]);
    const at = args.indexOf("/etc/resolv.conf");
    expect(args.slice(at - 2, at + 1)).toEqual(["--ro-bind", RESOLV, "/etc/resolv.conf"]);
    expect(args.join(" ")).not.toContain("/etc/resolv.conf /etc/resolv.conf");
    // Every other /etc piece is still bound as before.
    expect(args.join(" ")).toContain("--ro-bind-try /etc/hosts /etc/hosts");
  });

  it("refuses wall mode without a resolver file, rather than binding the host's", () => {
    expect(() => buildBwrapArgs({ homeDir: HOME, command: "true", network: "wall" })).toThrow(/resolvPath/);
  });
});
