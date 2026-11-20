import { createHash } from 'crypto';
import path from 'path';
import type { Dependency } from './DependencyAnalyzer';
import { toHostPathKey } from './utils/HostPlatform';
import { assertLibraryLayoutInputsCurrent, libraryLayoutForSourceRoot,
  type LibraryLayout, type LibraryLayoutInputs, type LibraryDirectoryShape } from './LibraryLayout';
import type { LibraryHeaderInputs } from './LibraryIndexCache';
import { PreprocessInputChangedError } from './DirectiveTapeSnapshot';

export type LibrarySource = 'platform' | 'additional' | 'project';

interface LibraryCandidate {
  dependency: Dependency;
  folder: string;
  name: string;
  architectures: string[];
  source: LibrarySource;
  layout: LibraryLayout;
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
  private readonly ownerRoots = new Map<string, { dependency: Dependency; layout: LibraryLayout }>();
  private readonly layouts = new Map<Dependency, LibraryLayout>();
  private readonly metadataInputs = new Map<string, [string, string | null]>();
  private readonly directoryShapes = new Map<string, LibraryDirectoryShape>();
  private readonly owners = new Map<string, Dependency | undefined>();
  readonly headers = new Map<string, Dependency>();
  fingerprint = '';

  constructor(private readonly architecture: string) {}

  async add(directory: string, source: LibrarySource, headers: string[]): Promise<void> {
    await this.addLayout(await libraryLayoutForSourceRoot(directory), source, headers);
  }

  async addLayout(layout: LibraryLayout, source: LibrarySource, headers: string[]): Promise<void> {
    const directory = path.resolve(layout.sourceRoot);
    layout = { ...layout, ownerRoot: path.resolve(layout.ownerRoot), sourceRoot: directory,
      includeRoots: layout.includeRoots.map(root => path.resolve(root)),
      metadata: layout.metadata ? { ...layout.metadata, architectures: [...layout.metadata.architectures] } : undefined,
      metadataInputs: layout.metadataInputs?.map(([file, identity]) => [file, identity]),
      directoryShapes: layout.directoryShapes?.map(observation => ({ ...observation })) };
    this.observeLayoutInputs({ metadataInputs: layout.metadataInputs || [], directoryShapes: layout.directoryShapes || [] });
    const libraryDirectory = layout.metadata?.root || (toHostPathKey(path.basename(directory)) === toHostPathKey('src') ? path.dirname(directory) : directory);
    const folder = path.basename(libraryDirectory);
    const name = layout.metadata?.name || '';
    const architectures = layout.metadata?.architectures || [];
    const dependency: Dependency = { name: folder, path: directory, type: 'library', includes: [], others: [] };
    const candidate = { dependency, folder, name, architectures, source, layout };
    const ownerKey = libraryPathKey(layout.ownerRoot), previous = this.ownerRoots.get(ownerKey);
    if (!previous || previous.layout.kind !== 'explicit' || layout.kind === 'explicit') this.ownerRoots.set(ownerKey, { dependency, layout });
    this.layouts.set(dependency, layout);
    this.owners.clear();
    for (const header of [...headers, `__LIB_${folder}`]) {
      const candidates = this.candidates.get(header) || [];
      candidates.push(candidate);
      this.candidates.set(header, candidates);
    }
  }

  observeLayoutInputs(inputs: LibraryLayoutInputs): void {
    for (const [file, identity] of inputs.metadataInputs) {
      const exact = path.resolve(file), fileKey = libraryPathKey(exact), previous = this.metadataInputs.get(fileKey);
      if (previous && previous[1] !== identity) throw new PreprocessInputChangedError(exact, 'layout-input-changed');
      this.metadataInputs.set(fileKey, [exact, identity]);
    }
    for (const observation of inputs.directoryShapes) {
      const shapeKey = libraryPathKey(observation.directory), previous = this.directoryShapes.get(shapeKey);
      if (previous && previous.fingerprint !== observation.fingerprint) throw new PreprocessInputChangedError(observation.directory, 'layout-shape-changed');
      this.directoryShapes.set(shapeKey, { ...observation });
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
        candidate.layout.kind, libraryPathKey(candidate.layout.ownerRoot), candidate.layout.includeRoots.map(libraryPathKey),
        candidate.layout.metadata?.propertiesHash,
      ])]);
    }
    this.fingerprint = createHash('sha256').update(JSON.stringify([2, this.architecture, context, this.inputObservations()])).digest('hex');
  }

  inputObservations(): LibraryHeaderInputs {
    return [...this.metadataInputs.values()].map(([file, identity]) => [file, identity]);
  }

  layoutFor(dependency: Dependency): LibraryLayout | undefined { return this.layouts.get(dependency); }

  assertLayoutCurrent(): void {
    assertLibraryLayoutInputsCurrent({ metadataInputs: this.inputObservations(), directoryShapes: [...this.directoryShapes.values()] });
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
      owner = this.ownerRoots.get(key)?.dependency;
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
