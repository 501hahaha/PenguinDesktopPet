export function parseCommandArgs(value: string): string[] {
  const args: string[] = [];
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of value.matchAll(matcher)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return args.filter(Boolean);
}
