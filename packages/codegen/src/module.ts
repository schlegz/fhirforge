/**
 * One generated TypeScript module: tracks its type-only imports and body lines.
 */
export class TsModule {
  private readonly imports = new Map<string, Set<string>>();
  readonly lines: string[] = [];

  constructor(
    /** Path relative to the output folder, without extension, e.g. `resources/Patient`. */
    readonly path: string,
  ) {}

  /** Records `import type { name } from <module>` unless `module` is this module. */
  use(name: string, module: string): string {
    if (module !== this.path) {
      let names = this.imports.get(module);
      if (!names) this.imports.set(module, (names = new Set()));
      names.add(name);
    }
    return name;
  }

  push(...lines: string[]): void {
    this.lines.push(...lines);
  }

  render(header: string): string {
    const importLines = [...this.imports.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([module, names]) => {
        const list = [...names].sort().join(', ');
        return `import type { ${list} } from '${relativeSpecifier(this.path, module)}';`;
      });
    const parts = [header, ''];
    if (importLines.length) parts.push(...importLines, '');
    parts.push(...this.lines);
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
}

function relativeSpecifier(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1);
  const toParts = to.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) common++;
  const up = fromParts.length - common;
  const rest = toParts.slice(common).join('/');
  return `${up === 0 ? './' : '../'.repeat(up)}${rest}.js`;
}
