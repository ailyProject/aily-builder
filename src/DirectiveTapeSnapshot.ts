import fs from 'fs-extra';
import path from 'path';
import { readFileObservation, type FileObservation } from './FileObservation';
import { scanPreprocessorDirectives, type PreprocessorDirectiveTape } from './utils/PreprocessorDirectiveScanner';

export class PreprocessInputChangedError extends Error {
  readonly code = 'PREPROCESS_INPUTS_CHANGED';
  readonly retryable = true;
  readonly phase = 'dependency-analysis';

  constructor(readonly inputPath: string, readonly reason: string, public attempts = 1) {
    super('Preprocessing inputs changed; retry preprocessing.');
    this.name = 'PreprocessInputChangedError';
  }
}

export function isPreprocessInputChanged(error: unknown): error is PreprocessInputChangedError {
  return error instanceof PreprocessInputChangedError;
}

export interface ObservedDirectiveTape {
  readonly file: string;
  readonly identity: string;
  readonly tape: PreprocessorDirectiveTape;
}

/** Parsed bytes and their identity belong to one analysis generation. */
export class DirectiveTapeSnapshot {
  private positiveSpan?: Map<string, FileObservation>;
  constructor(private readonly tapes = new Map<string, ObservedDirectiveTape>()) {}

  private key(file: string): string { return path.resolve(file); }

  private requireFile(file: string, observation: FileObservation): string {
    if (observation.state !== 'present' || !observation.isFile || !observation.identity) {
      throw new PreprocessInputChangedError(file, observation.errorCode || observation.state);
    }
    return observation.identity;
  }

  /** Only a synchronous source/translation-unit parse may share observations. */
  withinSpan<T>(parse: () => T): T {
    const previous = this.positiveSpan;
    this.positiveSpan = new Map();
    try { return parse(); }
    finally { this.positiveSpan = previous; }
  }

  fileObservation(file: string, supplied?: FileObservation): FileObservation {
    const exact = this.key(file);
    const observation = supplied || this.positiveSpan?.get(exact) || readFileObservation(exact);
    if (observation.state === 'present' && observation.isFile) this.positiveSpan?.set(exact, observation);
    return observation;
  }

  /** Runs before a once/active-stack shortcut can discard a repeated include. */
  observe(file: string, observation: FileObservation): void {
    const loaded = this.tapes.get(this.key(file));
    if (loaded && this.requireFile(file, observation) !== loaded.identity) {
      throw new PreprocessInputChangedError(file, 'directive-tape-identity-changed');
    }
  }

  read(file: string, suppliedObservation?: FileObservation): ObservedDirectiveTape {
    const exact = this.key(file);
    const before = this.fileObservation(exact, suppliedObservation);
    const identity = this.requireFile(exact, before);
    const loaded = this.tapes.get(exact);
    if (loaded) {
      if (loaded.identity !== identity) throw new PreprocessInputChangedError(exact, 'directive-tape-identity-changed');
      return loaded;
    }

    let bytes: Buffer;
    try { bytes = fs.readFileSync(exact); }
    catch { throw new PreprocessInputChangedError(exact, 'directive-tape-read-unavailable'); }
    const after = readFileObservation(exact);
    if (this.requireFile(exact, after) !== identity || bytes.length !== before.stat?.size) {
      throw new PreprocessInputChangedError(exact, 'directive-tape-changed-during-read');
    }
    const captured = { file: exact, identity, tape: scanPreprocessorDirectives(bytes) };
    this.tapes.set(exact, captured);
    return captured;
  }

  reference(file: string): ObservedDirectiveTape | undefined { return this.tapes.get(this.key(file)); }

  /** A new observation after async directory work; no old validity is memoized. */
  verifyLoaded(): void {
    for (const entry of this.tapes.values()) this.observe(entry.file, readFileObservation(entry.file));
  }
}
