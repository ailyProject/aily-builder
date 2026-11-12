import { createHash } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import type { Dependency } from './DependencyAnalyzer';
import { toHostPathKey } from './utils/HostPlatform';

export type LibrarySource = 'platform' | 'additional' | 'project';

interface LibraryCandidate {
  dependency: Dependency;
  folder: string;
  name: string;
  architectures: string[];
  source: LibrarySource;
}

const sourcePriority: Record<LibrarySource, number> = { platform: 0, additional: 1, project: 2 };

export function libraryPathKey(directory: string): string {
  return toHostPathKey(path.resolve(directory));
}

function matchPriority(name: string, header: string): number {
  if (name === header) return 6;
  if (name === header + '-main') return 5;
  if (name === header + '-master') return 4;
  if (name.startsWith(header)) return 3;
  if (name.endsWith(header)) return 2;
  return Number(name.includes(header));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

export class LibrarySelection {
  private readonly candidates = new Map<string, LibraryCandidate[]>();
  private readonly sourceDirectories = new Map<string, Dependency>();
  private readonly owners = new Map<string, Dependency | undefined>();
  readonly headers = new Map<string, Dependency>();
  fingerprint = '';

  constructor(private readonly architecture: string) {}

  async add(directory: string, source: LibrarySource, headers: string[]): Promise<void> {
    const libraryDirectory = path.basename(directory) === 'src' ? path.dirname(directory) : directory;
    const folder = path.basename(libraryDirectory);
    const properties = await fs.readFile(path.join(libraryDirectory, 'library.properties'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    const name = properties.match(/^[ \t\uFEFF]*name[ \t]*=([^\r\n]*)/m)?.[1].trim().replace(/\s+/g, '_') || '';
    const architectures = (properties.match(/^[ \t\uFEFF]*architectures[ \t]*=([^\r\n]*)/m)?.[1] || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    const dependency: Dependency = { name: folder, path: directory, type: 'library', includes: [], others: [] };
    const candidate = { dependency, folder, name, architectures, source };
    this.sourceDirectories.set(libraryPathKey(directory), dependency);
    for (const header of [...headers, `__LIB_${folder}`]) {
      const candidates = this.candidates.get(header) || [];
      candidates.push(candidate);
      this.candidates.set(header, candidates);
    }
  }

  resolve(): void {
    const context = [];
    for (const [header, candidates] of [...this.candidates].sort(([left], [right]) => compareText(left, right))) {
      const stem = header.startsWith('__LIB_') ? header.slice(6) : path.parse(header).name;
      const ranked = candidates.map(candidate => ({ candidate, priority: this.rank(candidate, stem) }));
      ranked.sort((left, right) => {
        for (let index = 0; index < left.priority.length; index++) {
          if (left.priority[index] !== right.priority[index]) return right.priority[index] - left.priority[index];
        }
        return compareText(left.candidate.folder, right.candidate.folder)
          || compareText(libraryPathKey(left.candidate.dependency.path), libraryPathKey(right.candidate.dependency.path));
      });
      this.headers.set(header, ranked[0].candidate.dependency);
      context.push([header, ranked.map(({ candidate }) => [
        libraryPathKey(candidate.dependency.path), candidate.source, candidate.folder, candidate.name, candidate.architectures,
      ])]);
    }
    this.fingerprint = createHash('sha256').update(JSON.stringify([1, this.architecture, context])).digest('hex');
  }

  owner(file: string): Dependency | undefined {
    let directory = path.dirname(path.resolve(file));
    const visited: string[] = [];
    let owner: Dependency | undefined;
    while (true) {
      const key = toHostPathKey(directory);
      if (this.owners.has(key)) {
        owner = this.owners.get(key);
        break;
      }
      visited.push(key);
      owner = this.sourceDirectories.get(key);
      if (owner) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    for (const key of visited) this.owners.set(key, owner);
    return owner;
  }

  forHeader(header: string, selectedPaths: readonly string[]): Dependency | undefined {
    const candidates = this.candidates.get(header);
    if (candidates?.length > 1) {
      for (const selected of selectedPaths) {
        const candidate = candidates.find(item => item.dependency.path === selected);
        if (candidate) return candidate.dependency;
      }
    }
    return this.headers.get(header);
  }

  private rank(candidate: LibraryCandidate, header: string): number[] {
    // Arduino's library-name rules apply after the compiler's existing search paths.
    const optimized = candidate.architectures.includes(this.architecture);
    const compatible = !this.architecture || optimized
      || !candidate.architectures.length || candidate.architectures.includes('*');
    const name = matchPriority(candidate.name, header);
    const folder = matchPriority(candidate.folder, header);
    return [
      Number(candidate.source === 'project'),
      Number(compatible),
      Number(name === 6 && folder === 6),
      Math.max(name, folder),
      Number(optimized),
      sourcePriority[candidate.source],
    ];
  }
}

/** Ninja uses library names for variables and archive filenames. Keep separate roots distinct. */
export function uniqueDependencyNames(dependencies: Iterable<Dependency>): Dependency[] {
  const items = [...dependencies];
  const ninjaName = (name: string) => name.replace(/[^a-zA-Z0-9]/g, '_');
  const used = new Set(items.filter(dependency => dependency.type !== 'library').map(dependency => ninjaName(dependency.name)));
  return items.map(dependency => {
    if (dependency.type !== 'library') return dependency;
    let name = dependency.name;
    if (used.has(ninjaName(name))) {
      const suffix = createHash('sha256').update(libraryPathKey(dependency.path)).digest('hex').slice(0, 12);
      name += '_' + suffix;
    }
    used.add(ninjaName(name));
    return name === dependency.name ? dependency : { ...dependency, name };
  });
}
