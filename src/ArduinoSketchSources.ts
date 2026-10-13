import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';

/** Arduino compiles the folder-named tab first, then other tabs alphabetically. */
export async function collectArduinoSketchTabs(entry: string): Promise<string[]> {
  if (path.extname(entry).toLowerCase() !== '.ino') return [entry];
  const root = path.dirname(entry);
  const names = (await fs.readdir(root, { withFileTypes: true }))
    .filter(item => item.isFile() && /\.(ino|pde)$/i.test(item.name))
    .map(item => item.name).sort();
  const primary = names.find(name => name.toLowerCase() === `${path.basename(root)}.ino`.toLowerCase())
    || path.basename(entry);
  return [primary, ...names.filter(name => name !== primary)].map(name => path.join(root, name));
}

export async function readArduinoSketch(entry: string): Promise<string> {
  const tabs = await collectArduinoSketchTabs(entry);
  const parts = await Promise.all(tabs.map(async filename =>
    `#line 1 ${JSON.stringify(filename.replace(/\\/g, '/'))}\n${await fs.readFile(filename, 'utf8')}\n`));
  return parts.join('\n');
}

/** Only root translation units and src/ recurse; data/, examples/ and caches do not. */
export async function collectArduinoSketchSources(entry: string): Promise<string[]> {
  if (path.extname(entry).toLowerCase() !== '.ino') return [];
  const root = path.dirname(entry);
  return (await glob(['*', 'src/**/*'], { cwd: root, absolute: true, nodir: true, follow: false }))
    .filter(filename => ['.c', '.cpp', '.cc', '.cxx', '.S', '.s'].includes(path.extname(filename)))
    .sort();
}
