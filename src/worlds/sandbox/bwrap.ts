// The Bubblewrap argument list for the sandbox. A pure function. The host paths it binds are the Lar's home folder
// (read-write) and, when given, the allow-listed parts of the Natalis checkout (read-only, at /body). The entity
// folder, the vault and every env file stay out of the sandbox by construction.

import { BODY_BINDS, BODY_MOUNT } from "./body.js";

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
};

/** The read-only binds of the allow-listed names of the checkout, each at the same path under /body. Absent names are skipped. */
function bodyBinds(checkout: string): string[] {
  return BODY_BINDS.flatMap((name) => ["--ro-bind-try", `${checkout}/${name}`, `${BODY_MOUNT}/${name}`]);
}

/** The full argument list for `bwrap`, ending with the shell and its command. */
export function buildBwrapArgs(input: BwrapInput): string[] {
  const etc = ETC_PIECES.flatMap((piece) => ["--ro-bind-try", `/etc/${piece}`, `/etc/${piece}`]);
  return [
    // Every namespace, then the network back on: the Lar has network, nothing else from the host is shared.
    "--unshare-all",
    "--share-net",
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
