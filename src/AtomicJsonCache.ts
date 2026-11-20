import native from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// Existing destinations can be briefly locked by another process on Windows.
// Retry only replacement; never remove a valid destination to make it succeed.
const sharingErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);
const retryDelays = [5, 10, 20, 40, 80];

async function replace(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await native.rename(temporary, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !sharingErrors.has((error as NodeJS.ErrnoException).code || '')
        || attempt >= retryDelays.length) throw error;
      await setTimeout(retryDelays[attempt]);
    }
  }
}

/** Readers see an old or new complete JSON record. The last replacement wins. */
export async function publishAtomicJsonCache(destination: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Cache value is not JSON serializable');
  await native.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  let handle: native.FileHandle | undefined, ownsTemporary = false;
  try {
    handle = await native.open(temporary, 'wx');
    ownsTemporary = true;
    await handle.writeFile(serialized + '\n', 'utf8');
    await handle.close();
    handle = undefined;
    await replace(temporary, destination);
  } catch (error) {
    // A failed open did not grant ownership. Cleanup cannot replace the
    // publication error or touch another writer's temporary/destination.
    if (handle) { try { await handle.close(); } catch { /* Preserve publication failure. */ } }
    if (ownsTemporary) { try { await native.unlink(temporary); } catch { /* Preserve publication failure. */ } }
    throw error;
  }
}
