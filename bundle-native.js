const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');

const DIST_MAIN_PATH = './dist/main.js';
const BUNDLE_DIR = './dist/bundle-min';
const ESBUILD_EXTERNALS = [
  'tree-sitter',
  'tree-sitter-cpp',
  '@ast-grep/napi',
  '@ast-grep/lang-cpp',
];

async function bundleWithNativeMinified() {
  try {
    const options = parseBundleOptions();
    ensureBuilt();

    console.log('Building minified bundle with native modules...');
    if (options.defaultGenerateArchiveCloudCache) {
      console.log('Archive cloud cache generation defaults to enabled in this bundle.');
    }
    await fs.emptyDir(BUNDLE_DIR);

    await bundleJavaScript(BUNDLE_DIR);
    await copyNativeModules(BUNDLE_DIR);
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
    external: ESBUILD_EXTERNALS,
    minify: true,
    sourcemap: false,
    logLevel: 'info',
  });
}

async function copyNativeModules(bundleDir) {
  await copyTreeSitter(bundleDir);
  await copyTreeSitterCpp(bundleDir);
  await copyAstGrep(bundleDir);
}

async function copyTreeSitter(bundleDir) {
  console.log('Copying tree-sitter native module...');

  const treeSitterSrc = './node_modules/tree-sitter';
  const treeSitterDest = path.join(bundleDir, 'node_modules/tree-sitter');
  await fs.ensureDir(treeSitterDest);

  await fs.copy(path.join(treeSitterSrc, 'index.js'), path.join(treeSitterDest, 'index.js'));
  await fs.copy(path.join(treeSitterSrc, 'package.json'), path.join(treeSitterDest, 'package.json'));

  const buildSrc = path.join(treeSitterSrc, 'build', 'Release');
  const buildDest = path.join(treeSitterDest, 'build', 'Release');
  await copyMatchingFiles(buildSrc, buildDest, (file) => file.endsWith('.node'));
}

async function copyTreeSitterCpp(bundleDir) {
  console.log('Copying tree-sitter-cpp native module...');

  const treeSitterCppSrc = './node_modules/tree-sitter-cpp';
  const treeSitterCppDest = path.join(bundleDir, 'node_modules/tree-sitter-cpp');
  await fs.ensureDir(treeSitterCppDest);

  await fs.copy(path.join(treeSitterCppSrc, 'package.json'), path.join(treeSitterCppDest, 'package.json'));

  const bindingsSrc = path.join(treeSitterCppSrc, 'bindings', 'node');
  const bindingsDest = path.join(treeSitterCppDest, 'bindings', 'node');
  await copyMatchingFiles(bindingsSrc, bindingsDest, (file) => file.endsWith('.js'));

  const buildSrc = path.join(treeSitterCppSrc, 'build', 'Release');
  const buildDest = path.join(treeSitterCppDest, 'build', 'Release');
  await copyMatchingFiles(buildSrc, buildDest, (file) => file.endsWith('.node'));
}

async function copyAstGrep(bundleDir) {
  console.log('Copying @ast-grep native modules...');

  await copyPackageRootFiles(
    './node_modules/@ast-grep/napi',
    path.join(bundleDir, 'node_modules/@ast-grep/napi'),
    ['index.js', 'package.json'],
  );

  await copyPackageRootFiles(
    './node_modules/@ast-grep/setup-lang',
    path.join(bundleDir, 'node_modules/@ast-grep/setup-lang'),
    ['index.js', 'package.json'],
  );

  const astGrepLangCppSrc = './node_modules/@ast-grep/lang-cpp';
  const astGrepLangCppDest = path.join(bundleDir, 'node_modules/@ast-grep/lang-cpp');
  await copyPackageRootFiles(astGrepLangCppSrc, astGrepLangCppDest, ['index.js', 'package.json']);
  await copyAstGrepLangPrebuild(astGrepLangCppSrc, astGrepLangCppDest);
  await copyAstGrepNativePackage(bundleDir);
}

async function copyAstGrepLangPrebuild(packageSrc, packageDest) {
  const prebuildsDir = path.join(packageSrc, 'prebuilds');
  if (!(await fs.pathExists(prebuildsDir))) {
    return;
  }

  const prebuildMap = {
    win32: 'prebuild-Windows-X64',
    darwin: process.arch === 'arm64' ? 'prebuild-macOS-ARM64' : 'prebuild-macOS-X64',
    linux: process.arch === 'arm64' ? 'prebuild-Linux-ARM64' : 'prebuild-Linux-X64',
  };

  const targetPrebuild = prebuildMap[process.platform];
  if (!targetPrebuild) {
    return;
  }

  const prebuildSrc = path.join(prebuildsDir, targetPrebuild);
  if (await fs.pathExists(prebuildSrc)) {
    await fs.copy(prebuildSrc, path.join(packageDest, 'prebuilds', targetPrebuild));
  }
}

async function copyAstGrepNativePackage(bundleDir) {
  const platformNativeModule = {
    'win32-x64': '@ast-grep/napi-win32-x64-msvc',
    'darwin-x64': '@ast-grep/napi-darwin-x64',
    'darwin-arm64': '@ast-grep/napi-darwin-arm64',
    'linux-x64': '@ast-grep/napi-linux-x64-gnu',
    'linux-arm64': '@ast-grep/napi-linux-arm64-gnu',
  };

  const platformKey = `${process.platform}-${process.arch}`;
  const targetModule = platformNativeModule[platformKey];
  if (!targetModule) {
    console.log(`No ast-grep native module configured for platform: ${platformKey}`);
    return;
  }

  const modSrc = `./node_modules/${targetModule}`;
  if (await fs.pathExists(modSrc)) {
    await fs.copy(modSrc, path.join(bundleDir, 'node_modules', targetModule), {
      filter: (src) => !src.endsWith('.md') && !src.endsWith('.d.ts'),
    });
  }
}

async function copyNinja(bundleDir) {
  console.log('Copying ninja build tool...');

  const ninjaDir = './ninja';
  const ninjaDest = path.join(bundleDir, 'ninja');
  await fs.ensureDir(ninjaDest);

  if (process.platform === 'win32') {
    const ninjaExeSrc = path.join(ninjaDir, 'ninja.exe');
    if (await fs.pathExists(ninjaExeSrc)) {
      await fs.copy(ninjaExeSrc, path.join(ninjaDest, 'ninja.exe'));
    } else {
      console.log('ninja.exe not found in ./ninja directory.');
    }
    return;
  }

  const ninjaBinSrc = path.join(ninjaDir, 'ninja');
  if (await fs.pathExists(ninjaBinSrc)) {
    await fs.copy(ninjaBinSrc, path.join(ninjaDest, 'ninja'));
    await fs.chmod(path.join(ninjaDest, 'ninja'), '755');
  } else {
    console.log('ninja not found in ./ninja directory.');
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
      aily: 'index.js',
    },
    engines: {
      node: '>=16',
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

async function copyPackageRootFiles(packageSrc, packageDest, files) {
  if (!(await fs.pathExists(packageSrc))) {
    return;
  }

  await fs.ensureDir(packageDest);
  for (const file of files) {
    const src = path.join(packageSrc, file);
    if (await fs.pathExists(src)) {
      await fs.copy(src, path.join(packageDest, file));
    }
  }
}

async function copyMatchingFiles(sourceDir, destDir, shouldCopy) {
  if (!(await fs.pathExists(sourceDir))) {
    return;
  }

  await fs.ensureDir(destDir);
  const files = await fs.readdir(sourceDir);
  for (const file of files) {
    if (shouldCopy(file)) {
      await fs.copy(path.join(sourceDir, file), path.join(destDir, file));
    }
  }
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

bundleWithNativeMinified();
