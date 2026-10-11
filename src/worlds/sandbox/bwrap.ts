// The Bubblewrap argument list for the sandbox. A pure function. The host paths it binds are the Lar's home folder
// (read-write) and, when given, the allow-listed parts of the Natalis checkout (read-only, at /body). The entity
// folder, the vault and every env file stay out of the sandbox by construction.

import { BODY_BINDS, BODY_MOUNT } from "./body.js";
import type { SandboxNetwork } from "./config.js";

/** Where the Lar's home folder appears inside the sandbox. */
export const SANDBOX_HOME = "/home/lar";

/** The PATH the sandbox's commands see. What the Lar installs (pip --user, npm -g) lands in ~/.local/bin, first. */
export const SANDBOX_PATH = "/home/lar/.local/bin:/usr/local/bin:/usr/bin:/bin";

/** Read-only pieces of /etc that networking and common tools need. Each is bound only when it exists on the host. */
export const ETC_PIECES = ["resolv.conf", "hosts", "nsswitch.conf", "ssl", "ca-certificates", "alternatives", "localtime"];

export type BwrapInput = {
  /** The host folder that becomes the Lar's home. Must exist before bwrap runs. */
  homeDir: string;
  /** The shell command, run as `bash -lc <command>`. */
  command: string;
  /** The Natalis checkout: its allow-listed names are bound read-only at /body. Left out, nothing of the checkout is in the sandbox. */
  bodyDir?: string;
  /**
   * "host" (left out): the host's network, as before the wall. "wall": a private network that pasta has already made and
   * walled (the caller runs bwrap under pasta); bwrap shares it, and /etc/resolv.conf is resolvPath. "none": loopback only.
   */
  network?: SandboxNetwork;
  /** For "wall": a file holding the resolver the command uses, bound read-only at /etc/resolv.conf in place of the host's. */
  resolvPath?: string;
};

/**
 * The read-only binds of the allow-listed names of the checkout, each at the same path under /body. Absent names are
 * skipped. /body itself is a small tmpfs remounted read-only after the binds, so nothing can be written beside them.
 */
function bodyBinds(checkout: string): string[] {
  return [
    "--tmpfs",
    BODY_MOUNT,
    ...BODY_BINDS.flatMap((name) => ["--ro-bind-try", `${checkout}/${name}`, `${BODY_MOUNT}/${name}`]),
    "--remount-ro",
    BODY_MOUNT,
  ];
}

/**
 * The full argument list for `bwrap`, ending with the shell and its command.
 *
 * Network: "host" shares the host's network; "wall" shares the private network pasta made (see wall.ts), which is not
 * the host's; "none" leaves out --share-net, so only the command's own loopback is there. --unshare-all already
 * unshares the network, so "none" needs nothing more.
 */
export function buildBwrapArgs(input: BwrapInput): string[] {
  const network = input.network ?? "host";
  if (network === "wall" && input.resolvPath === undefined) {
    throw new RangeError('The "wall" network needs the resolver file (resolvPath); the host\'s /etc/resolv.conf is never bound.');
  }
  // In the wall the host's resolver is not bound: it may sit on the host's loopback or local network, which the wall keeps out.
  const etc =
    network === "wall"
      ? [
          ...ETC_PIECES.filter((piece) => piece !== "resolv.conf").flatMap((piece) => ["--ro-bind-try", `/etc/${piece}`, `/etc/${piece}`]),
          "--ro-bind",
          input.resolvPath as string,
          "/etc/resolv.conf",
        ]
      : ETC_PIECES.flatMap((piece) => ["--ro-bind-try", `/etc/${piece}`, `/etc/${piece}`]);
  return [
    "--unshare-all",
    ...(network === "none" ? [] : ["--share-net"]),
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    // The system, read-only. The usual top-level names point into it.
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
    ...etc,
    // The only writable host folder: the Lar's home.
    "--bind",
    input.homeDir,
    SANDBOX_HOME,
    // The Lar's own source and docs, read-only: only the allow-listed names of the checkout. A write fails at the filesystem.
    ...(input.bodyDir === undefined ? [] : bodyBinds(input.bodyDir)),
    "--chdir",
    SANDBOX_HOME,
    "--setenv",
    "PATH",
    SANDBOX_PATH,
    "--setenv",
    "HOME",
    SANDBOX_HOME,
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "TERM",
    "dumb",
    // npm -g installs into the home too, beside pip --user.
    "--setenv",
    "NPM_CONFIG_PREFIX",
    `${SANDBOX_HOME}/.local`,
    "bash",
    "-lc",
    input.command,
  ];
}
