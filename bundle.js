const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');

const DIST_MAIN_PATH = './dist/main.js';
const BUNDLE_DIR = './dist/bundle-min';

async function bundleMinified() {
  try {
    const options = parseBundleOptions();
    ensureBuilt();

    console.log('Building minified bundle...');
    if (options.defaultGenerateArchiveCloudCache) {
      console.log('Archive cloud cache generation defaults to enabled in this bundle.');
    }
    await fs.emptyDir(BUNDLE_DIR);

    await bundleJavaScript(BUNDLE_DIR);
    await copyNinja(BUNDLE_DIR);
    await createLaunchScript(BUNDLE_DIR, options);
    await createPackageJson(BUNDLE_DIR, options);

    const bundleStats = await getBundleStats(BUNDLE_DIR);
    console.log('Minified bundle created successfully.');
    console.log(`Output directory: ${BUNDLE_DIR}`);
    console.log(`Total bundle size: ${bundleStats.totalSizeFormatted}`);
    console.log(`Files included: ${bundleStats.fileCount}`);
  } catch (error) {
    console.error('Minified bundle creation failed:', error);
    process.exit(1);
  }
}

function parseBundleOptions() {
  const args = new Set(process.argv.slice(2));
  const envValue = process.env.AILY_BUILDER_BUNDLE_GENERATE_ARCHIVE_CLOUD_CACHE?.toLowerCase();

  return {
    defaultGenerateArchiveCloudCache:
      args.has('--generate-archive-cloud-cache-default') ||
      args.has('--default-generate-archive-cloud-cache') ||
      envValue === '1' ||
      envValue === 'true',
  };
}

function ensureBuilt() {
  if (!fs.existsSync(DIST_MAIN_PATH)) {
    console.log('dist/main.js not found. Please run "npm run build" first.');
    process.exit(1);
  }
}

async function bundleJavaScript(bundleDir) {
  console.log('Bundling JavaScript code...');
  await esbuild.build({
    entryPoints: [DIST_MAIN_PATH],
    bundle: true,
    platform: 'node',
    target: 'node16',
    format: 'cjs',
    outfile: path.join(bundleDir, 'aily-builder.js'),
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });
}

async function copyNinja(bundleDir) {
  console.log('Copying Ninja build tools for Windows and macOS...');

  const ninjaDir = './ninja';
  const ninjaDest = path.join(bundleDir, 'ninja');
  await fs.ensureDir(ninjaDest);

  const ninjaFiles = [
    { name: 'ninja.exe', executable: false },
    { name: 'ninja', executable: true },
  ];

  for (const ninjaFile of ninjaFiles) {
    const sourcePath = path.join(ninjaDir, ninjaFile.name);
    const destinationPath = path.join(ninjaDest, ninjaFile.name);

    if (!await fs.pathExists(sourcePath)) {
      throw new Error(`${ninjaFile.name} not found in ${ninjaDir} directory.`);
    }

    await fs.copy(sourcePath, destinationPath);
    if (ninjaFile.executable) {
      await fs.chmod(destinationPath, '755');
    }
  }
}

async function createLaunchScript(bundleDir, options) {
  const defaultEnv = options.defaultGenerateArchiveCloudCache
    ? `if (process.env.AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE === undefined) {
  process.env.AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE = '1';
}
`
    : '';

  const launchScript = `#!/usr/bin/env node
${defaultEnv}
require('./aily-builder.js');
`;

  const launchScriptPath = path.join(bundleDir, 'index.js');
  await fs.writeFile(launchScriptPath, launchScript);

  if (process.platform !== 'win32') {
    await fs.chmod(launchScriptPath, '755');
    await fs.chmod(path.join(bundleDir, 'aily-builder.js'), '755');
  }
}

async function createPackageJson(bundleDir, options) {
  const projectPackageJson = await fs.readJson('./package.json');
  const bundlePackageJson = {
    name: projectPackageJson.name,
    version: projectPackageJson.version,
    description: projectPackageJson.description,
    main: 'index.js',
    bin: {
      'aily-builder': 'index.js',
    },
    engines: {
      node: projectPackageJson.engines?.node || '>=18',
    },
    ailyBuilder: {
      defaultGenerateArchiveCloudCache: options.defaultGenerateArchiveCloudCache,
    },
  };

  await fs.writeFile(
    path.join(bundleDir, 'package.json'),
    `${JSON.stringify(bundlePackageJson, null, 2)}\n`,
  );
}

async function getBundleStats(bundleDir) {
  let totalSize = 0;
  let fileCount = 0;

  async function walkDir(dir) {
    const items = await fs.readdir(dir);
    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = await fs.stat(itemPath);
      if (stat.isDirectory()) {
        await walkDir(itemPath);
      } else {
        totalSize += stat.size;
        fileCount++;
      }
    }
  }

  await walkDir(bundleDir);

  const totalSizeFormatted = totalSize > 1024 * 1024
    ? `${(totalSize / 1024 / 1024).toFixed(2)} MB`
    : `${(totalSize / 1024).toFixed(1)} KB`;

  return { totalSize, totalSizeFormatted, fileCount };
}

bundleMinified();
