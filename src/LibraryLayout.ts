import { createHash } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import type { Dirent } from 'fs';
import type { LibraryHeaderInputs } from './LibraryIndexCache';
import { readFileObservation } from './FileObservation';
import { PreprocessInputChangedError } from './DirectiveTapeSnapshot';
import { toHostPathKey } from './utils/HostPlatform';

export interface LibraryMetadata {
  readonly root: string;
  readonly propertiesPath: string;
  readonly propertiesHash: string;
  readonly name: string;
  readonly architectures: string[];
}

export interface LibraryDirectoryShape {
  /** A discovery root, with a fingerprint of its selection/ownership semantics. */
  readonly directory: string;
  readonly fingerprint: string | null;
}

export interface LibraryLayoutInputs {
  readonly metadataInputs: LibraryHeaderInputs;
  readonly directoryShapes: LibraryDirectoryShape[];
}

export interface LibraryDiscoveryOptions {
  readonly explicitSourceRoot?: boolean;
  /** Receives facts even when no layout was discovered in a search root. */
  readonly onInputs?: (inputs: LibraryLayoutInputs) => void;
}

/** Ownership includes implementation fragments; compilation stays at sourceRoot. */
export interface LibraryLayout {
  readonly kind: 'arduino' | 'legacy' | 'explicit';
  readonly ownerRoot: string;
  readonly sourceRoot: string;
  readonly includeRoots: string[];
  readonly metadata?: LibraryMetadata;
  readonly metadataInputs?: LibraryHeaderInputs;
  readonly directoryShapes?: LibraryDirectoryShape[];
}

const sourceFile = new RegExp('\\.(?:h|hpp|c|cpp|s|S)$', process.platform === 'win32' ? 'i' : '');
const ignoredDirectories = new Set(['examples', 'extras', 'test', 'tests', 'docs']);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const key = (file: string): string => toHostPathKey(path.resolve(file));
const ignored = (name: string): boolean => name.startsWith('.') || ignoredDirectories.has(toHostPathKey(name));
const isSrc = (name: string): boolean => toHostPathKey(name) === toHostPathKey('src');

function fileFact(file: string): string | null {
  const observation = readFileObservation(file);
  if (observation.state === 'unavailable') {
    throw new PreprocessInputChangedError(file, observation.errorCode || 'layout-input-unavailable');
  }
  return observation.identity ?? null;
}

function remember(inputs: Map<string, [string, string | null]>, file: string, identity: string | null): void {
  const previous = inputs.get(key(file));
  if (previous && previous[1] !== identity) throw new PreprocessInputChangedError(file, 'layout-input-changed');
  inputs.set(key(file), [path.resolve(file), identity]);
}

async function readMetadata(directory: string, inputs: Map<string, [string, string | null]>): Promise<LibraryMetadata | undefined> {
  const file = path.join(directory, 'library.properties');
  const before = readFileObservation(file);
  if (before.state === 'unavailable') throw new PreprocessInputChangedError(file, before.errorCode || 'metadata-unavailable');
  remember(inputs, file, before.identity ?? null);
  if (before.state === 'missing') return undefined;
  if (!before.isFile || !before.identity) throw new PreprocessInputChangedError(file, 'metadata-not-file');
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); }
  catch (error) { throw new PreprocessInputChangedError(file, (error as NodeJS.ErrnoException).code || 'metadata-read-unavailable'); }
  const after = readFileObservation(file);
  if (after.state !== 'present' || !after.isFile || after.identity !== before.identity || bytes.length !== before.stat?.size) {
    throw new PreprocessInputChangedError(file, 'metadata-changed-during-read');
  }
  const text = bytes.toString('utf8');
  return {
    root: directory, propertiesPath: file, propertiesHash: hash(bytes),
    name: text.match(/^[ \t\uFEFF]*name[ \t]*=([^\r\n]*)/m)?.[1].trim().replace(/\s+/g, '_') || '',
    architectures: (text.match(/^[ \t\uFEFF]*architectures[ \t]*=([^\r\n]*)/m)?.[1] || '')
      .split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  };
}

function directoryEntry(entry: Dirent, directory: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  const file = path.join(directory, entry.name), observation = readFileObservation(file);
  if (observation.state === 'unavailable') throw new PreprocessInputChangedError(file, observation.errorCode || 'layout-path-unavailable');
  return observation.stat?.isDirectory() === true;
}

type LayoutBoundary = Pick<LibraryLayout, 'kind' | 'ownerRoot' | 'sourceRoot'>;
const publicHeader = new RegExp('\\.(?:h|hpp)$', process.platform === 'win32' ? 'i' : '');

function boundary(directory: string, entries: Dirent[], hasMetadata: boolean, inheritedRoot: boolean): LayoutBoundary | undefined {
  if (hasMetadata) {
    const src = entries.find(entry => isSrc(entry.name) && directoryEntry(entry, directory));
    return { kind: 'arduino', ownerRoot: directory, sourceRoot: src ? path.join(directory, src.name) : directory };
  }
  if (!inheritedRoot && entries.some(entry => !ignored(entry.name) && sourceFile.test(entry.name) && !directoryEntry(entry, directory))) {
    return { kind: 'legacy', ownerRoot: directory, sourceRoot: directory };
  }
  return undefined;
}

function layoutFingerprint(layouts: LayoutBoundary[], directories: Map<string, Dirent[]>): string {
  const descriptors = layouts.map(layout => {
    const entries = directories.get(key(layout.sourceRoot));
    if (!entries) throw new PreprocessInputChangedError(layout.sourceRoot, 'layout-source-root-unavailable');
    const headers = entries.filter(entry => !ignored(entry.name) && publicHeader.test(entry.name)
      && !directoryEntry(entry, layout.sourceRoot)).map(entry => entry.name).sort();
    const folder = layout.kind === 'arduino' ? path.basename(layout.ownerRoot)
      : path.basename(isSrc(path.basename(layout.sourceRoot)) ? path.dirname(layout.sourceRoot) : layout.sourceRoot);
    return [layout.kind, key(layout.ownerRoot), key(layout.sourceRoot), folder, headers];
  }).sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : Number(JSON.stringify(left) > JSON.stringify(right)));
  return hash(JSON.stringify(descriptors));
}

/** Inventory changes are checked by the index. Only changed layout decisions fail here. */
function currentLayoutFingerprint(directory: string): string {
  const initial = readFileObservation(directory);
  if (initial.state === 'unavailable') throw new PreprocessInputChangedError(directory, initial.errorCode || 'layout-directory-unavailable');
  if (initial.state === 'missing' || !initial.stat?.isDirectory()) return hash('[]');
  const layouts: LayoutBoundary[] = [], directories = new Map<string, Dirent[]>(), ancestors = new Set<string>();
  function visit(current: string, inheritedRoot = false): void {
    let physical: string, entries: Dirent[];
    try { physical = key(fs.realpathSync(current)); entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { throw new PreprocessInputChangedError(current, (error as NodeJS.ErrnoException).code || 'layout-directory-unavailable'); }
    if (ancestors.has(physical)) return;
    ancestors.add(physical);
    try {
      directories.set(key(current), entries);
      const properties = path.join(current, 'library.properties'), observation = readFileObservation(properties);
      if (observation.state === 'unavailable' || (observation.state === 'present' && !observation.isFile)) {
        throw new PreprocessInputChangedError(properties, observation.errorCode || 'metadata-not-file');
      }
      const layout = boundary(current, entries, observation.state === 'present', inheritedRoot);
      if (layout) layouts.push(layout);
      for (const entry of entries) {
        if (!ignored(entry.name) && directoryEntry(entry, current)) visit(path.join(current, entry.name), inheritedRoot || !!layout);
      }
    } finally { ancestors.delete(physical); }
  }
  visit(directory);
  return layoutFingerprint(layouts, directories);
}

/** Fresh completion check, separate from per-index metadata/header validation. */
export function assertLibraryLayoutCurrent(layouts: readonly LibraryLayout[]): void {
  const files = new Map<string, [string, string | null]>(), directories = new Map<string, LibraryDirectoryShape>();
  for (const layout of layouts) {
    for (const [file, identity] of layout.metadataInputs || []) remember(files, file, identity);
    for (const observation of layout.directoryShapes || []) {
      const prior = directories.get(key(observation.directory));
      if (prior && prior.fingerprint !== observation.fingerprint) throw new PreprocessInputChangedError(observation.directory, 'layout-shape-changed');
      directories.set(key(observation.directory), observation);
    }
  }
  assertLibraryLayoutInputsCurrent({ metadataInputs: [...files.values()], directoryShapes: [...directories.values()] });
}

export function assertLibraryLayoutInputsCurrent(inputs: LibraryLayoutInputs): void {
  for (const [file, identity] of inputs.metadataInputs) {
    if (fileFact(file) !== identity) throw new PreprocessInputChangedError(file, 'layout-input-changed');
  }
  for (const { directory, fingerprint } of inputs.directoryShapes) {
    if (currentLayoutFingerprint(directory) !== (fingerprint ?? hash('[]'))) {
      throw new PreprocessInputChangedError(directory, 'layout-shape-changed');
    }
  }
}

/** Compatibility for a caller that already selected an exact compilation root. */
export async function libraryLayoutForSourceRoot(directory: string, options: { explicitSourceRoot?: boolean } = {}): Promise<LibraryLayout> {
  directory = path.resolve(directory);
  const inputs = new Map<string, [string, string | null]>();
  let metadata = await readMetadata(directory, inputs);
  if (!metadata && isSrc(path.basename(directory))) metadata = await readMetadata(path.dirname(directory), inputs);
  const layout: LibraryLayout = {
    kind: options.explicitSourceRoot ? 'explicit' : metadata ? 'arduino' : 'legacy',
    ownerRoot: options.explicitSourceRoot ? directory : metadata?.root || directory,
    sourceRoot: directory, includeRoots: [directory], metadata,
    metadataInputs: [...inputs.values()],
  };
  assertLibraryLayoutCurrent([layout]);
  return layout;
}

/** Enumerate package layouts without promoting package-internal source directories. */
export async function discoverLibraryLayouts(directory: string, options: LibraryDiscoveryOptions = {}): Promise<LibraryLayout[]> {
  directory = path.resolve(directory);
  const initial = readFileObservation(directory);
  if (initial.state === 'unavailable') throw new PreprocessInputChangedError(directory, initial.errorCode || 'layout-directory-unavailable');
  if (initial.state === 'missing' || !initial.stat?.isDirectory()) {
    const inputs = { metadataInputs: [], directoryShapes: [{ directory, fingerprint: null }] };
    assertLibraryLayoutInputsCurrent(inputs);
    options.onInputs?.(inputs);
    return [];
  }
  if (options.explicitSourceRoot) {
    const layout = await libraryLayoutForSourceRoot(directory, options);
    options.onInputs?.({ metadataInputs: layout.metadataInputs!.map(([file, identity]) => [file, identity]), directoryShapes: [] });
    return [layout];
  }
  const layouts: LibraryLayout[] = [], inputs = new Map<string, [string, string | null]>();
  const directories = new Map<string, Dirent[]>(), ancestors = new Set<string>();
  async function visit(current: string, inheritedRoot = false): Promise<void> {
    let physical: string;
    try { physical = key(await fs.realpath(current)); }
    catch (error) { throw new PreprocessInputChangedError(current, (error as NodeJS.ErrnoException).code || 'layout-directory-unavailable'); }
    if (ancestors.has(physical)) return;
    ancestors.add(physical);
    try {
      let entries: Dirent[];
      try { entries = await fs.readdir(current, { withFileTypes: true }); }
      catch (error) { throw new PreprocessInputChangedError(current, (error as NodeJS.ErrnoException).code || 'layout-directory-unavailable'); }
      directories.set(key(current), entries);
      const metadata = await readMetadata(current, inputs);
      const layout = boundary(current, entries, !!metadata, inheritedRoot);
      if (layout) layouts.push({ ...layout, includeRoots: [layout.sourceRoot], metadata });
      for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : Number(left.name > right.name))) {
        if (ignored(entry.name) || !directoryEntry(entry, current)) continue;
        await visit(path.join(current, entry.name), inheritedRoot || !!layout);
      }
    } finally { ancestors.delete(physical); }
  }
  await visit(directory);
  const shapes = [{ directory, fingerprint: layoutFingerprint(layouts, directories) }];
  const facts: LibraryLayoutInputs = { metadataInputs: [...inputs.values()], directoryShapes: shapes };
  assertLibraryLayoutInputsCurrent(facts);
  options.onInputs?.({ metadataInputs: facts.metadataInputs.map(([file, identity]) => [file, identity]),
    directoryShapes: shapes.map(observation => ({ ...observation })) });
  const observed = layouts.map(layout => ({ ...layout,
    metadataInputs: [...inputs.values()].map(([file, identity]) => [file, identity] as [string, string | null]),
    directoryShapes: shapes.map(observation => ({ ...observation })),
  }));
  return observed;
}
