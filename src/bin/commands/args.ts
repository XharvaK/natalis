// Flag helpers shared by the command modules. A flag's value is the word right after it; a flag with no word after
// it has the value "" (so "--reason" alone is an empty reason, which the command refuses in plain words).

/** The word after `name`, or undefined when the flag is not there at all. Accepts `--name=value` too. */
export function flagValue(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === name) return args[i + 1] ?? "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}
