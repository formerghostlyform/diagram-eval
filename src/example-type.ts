export function exampleTypeOverride(args: string[]): string | undefined {
  const index = args.indexOf('--type');
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error('Use --type <id>.');
  return value;
}

export function inferExampleType(name: string, override?: string): string {
  if (override) return override;
  if (/context/i.test(name)) return 'c4-context';
  if (/container/i.test(name)) return 'c4-container';
  throw new Error(`Cannot infer diagram type from example: ${name}`);
}
