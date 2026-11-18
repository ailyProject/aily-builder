import path from 'path';

/** Only the source-selection prepass uses this inventory, never active includes. */
export class SourceFragmentInventory {
  private readonly sourceKeys: Set<string>;

  constructor(files: readonly string[], private readonly key: (file: string) => string) {
    this.sourceKeys = new Set(files.map(key));
  }

  mayContribute(include: string, directories?: readonly string[]): boolean {
    if (!directories || !include || include.includes('\0')) return true;
    try {
      // These are a superset for include_next too. A possible member always
      // falls back to the full resolver, including earlier external shadows.
      return directories.some(directory => this.sourceKeys.has(this.key(path.resolve(directory, include))));
    } catch {
      return true;
    }
  }
}
