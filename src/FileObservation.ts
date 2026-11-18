import fs from 'fs-extra';
import path from 'path';
import type { Stats } from 'fs';

export interface FileObservation {
  readonly state: 'present' | 'missing' | 'unavailable';
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly identity: string | undefined;
  readonly stat: Stats | undefined;
  readonly errorCode?: string;
}

/** Always fresh. An I/O failure is not evidence that a candidate is absent. */
export function readFileObservation(file: string): FileObservation {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return { state: 'missing', exists: false, isFile: false, identity: undefined, stat: undefined };
    return { state: 'present', exists: true, isFile: stat.isFile(), stat,
      identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    return { state: errorCode === 'ENOENT' || errorCode === 'ENOTDIR' ? 'missing' : 'unavailable',
      exists: false, isFile: false, identity: undefined, stat: undefined, errorCode };
  }
}

/** One synchronous validation boundary; callers create a new instance next time. */
export class FileObservationSnapshot {
  private readonly observations = new Map<string, FileObservation>();
  private key(file: string): string { return path.resolve(file); }

  read(file: string): FileObservation {
    const key = this.key(file);
    let observation = this.observations.get(key);
    if (!observation) { observation = readFileObservation(file); this.observations.set(key, observation); }
    return observation;
  }

  peek(file: string): FileObservation | undefined { return this.observations.get(this.key(file)); }
}
