export function summarizeValue(value: unknown, maxLen = 80): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}

export function summarizeArgs(args: Record<string, unknown>, maxLen = 60): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${summarizeValue(v, maxLen)}`)
    .join(', ');
}
