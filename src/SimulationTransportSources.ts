import fs from 'fs-extra';
import path from 'path';
import type { Dependency } from './DependencyAnalyzer';

export const ESP32_VHCI_PROVIDER = 'aily.esp32-vhci-v1';

/** A simulation build uses the real Bluetooth host library with an explicit controller transport. */
export async function prepareSimulationTransportSources(
  buildPath: string,
  simulationDebug: boolean,
  mcu: string | undefined,
  dependencies: Dependency[],
): Promise<{ providers: string[]; network?: { wifi: true; httpPort?: number } }> {
  const destination = path.join(buildPath, 'sketch', 'aily-esp32-vhci-v1.c');
  const dependencyName = '__simulation_transport__';
  const previous = dependencies.findIndex(dependency => dependency.name === dependencyName);

  if (previous >= 0) dependencies.splice(previous, 1);

  for (const dependency of dependencies) {
    dependency.includes = dependency.includes.filter(source => path.resolve(source) !== path.resolve(destination));
  }

  const library = (name: string) => dependencies.some(dependency => dependency.type === 'library' && dependency.name === name);
  const classic = simulationDebug && mcu === 'esp32';
  const network = classic && library('WiFi') ? { wifi: true as const, ...(library('WebServer') ? { httpPort: 80 } : {}) } : undefined;
  const enabled = classic && library('BluetoothSerial');

  if (!enabled) {
    await fs.remove(destination);

    return { providers: [], ...(network ? { network } : {}) };
  }

  // The normal TypeScript distribution and the bundled CLI keep resources beside their entry root.
  const directories = [path.join(__dirname, 'resources'), path.resolve(__dirname, '..', 'resources')];
  let source: string | undefined;

  for (const directory of directories) {
    const filename = path.join(directory, 'simulation', 'esp32-vhci-v1.c');

    if (await fs.pathExists(filename)) { source = filename; break; }
  }

  if (!source) throw new Error('ESP32 VHCI simulation provider source is missing from Builder.');

  await fs.ensureDir(path.dirname(destination));
  await fs.copyFile(source, destination);

  dependencies.push({ name: dependencyName, path: path.dirname(destination), type: 'sketch', includes: [destination], others: [] });

  return { providers: [ESP32_VHCI_PROVIDER], ...(network ? { network } : {}) };
}
