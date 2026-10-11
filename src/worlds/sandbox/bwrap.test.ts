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
      "/usr/local/bin:/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/home/lar",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--setenv",
      "TERM",
      "dumb",
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
    expect(args.filter((arg) => arg.startsWith("/home"))).toEqual([SANDBOX_HOME, SANDBOX_HOME, SANDBOX_HOME]);
  });

  it("clears the environment before setting the four variables, and sets no others", () => {
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
    ]);
    expect(SANDBOX_PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });

  it("passes the command as one argument, so nothing in it is split or quoted by the body", () => {
    const command = "printf '%s\\n' \"a b\"; ls -la /home/lar | head";
    const args = buildBwrapArgs({ homeDir: HOME, command });
    expect(args.slice(-3)).toEqual(["bash", "-lc", command]);
  });
});
