const esbuild = require('esbuild');
const fs = require('fs-extra');
const path = require('path');

// 构建包含原生模块的完整包
async function bundleWithNative() {
  try {
    // 首先检查 dist/main.js 是否存在
    const distMainPath = './dist/main.js';
    if (!fs.existsSync(distMainPath)) {
      console.log('❌ dist/main.js not found. Please run "npm run build" first.');
      process.exit(1);
    }

    console.log('📦 Building complete bundle with native modules...');
    
    // 创建输出目录
    const bundleDir = './dist/bundle';
    await fs.ensureDir(bundleDir);
    await fs.ensureDir(path.join(bundleDir, 'node_modules'));

    // 1. 使用 esbuild 打包 JavaScript 部分（排除原生模块）
    console.log('📦 Bundling JavaScript code...');
    const result = await esbuild.build({
      entryPoints: ['./dist/main.js'],
      bundle: true,
      platform: 'node',
      target: 'node16',
      format: 'cjs',
      outfile: path.join(bundleDir, 'aily-builder.js'),
      external: [
        'tree-sitter',
        'tree-sitter-cpp',
      ],
      banner: {
        js: process.platform === 'win32' ? '' : '#!/usr/bin/env node\n'
      },
      minify: false,
      sourcemap: false,
      logLevel: 'info'
    });

    // 2. 复制 tree-sitter 原生模块
    console.log('📦 Copying tree-sitter native modules...');
    
    // 复制 tree-sitter 主模块
    const treeSitterSrc = './node_modules/tree-sitter';
    const treeSitterDest = path.join(bundleDir, 'node_modules/tree-sitter');
    await fs.ensureDir(treeSitterDest);
    
    // 只复制必要的文件
    await fs.copy(path.join(treeSitterSrc, 'index.js'), path.join(treeSitterDest, 'index.js'));
    await fs.copy(path.join(treeSitterSrc, 'package.json'), path.join(treeSitterDest, 'package.json'));
    await fs.copy(path.join(treeSitterSrc, 'tree-sitter.d.ts'), path.join(treeSitterDest, 'tree-sitter.d.ts'));
    
    // 复制编译后的 .node 文件
    const treeSitterBuildSrc = path.join(treeSitterSrc, 'build');
    const treeSitterBuildDest = path.join(treeSitterDest, 'build');
    if (await fs.pathExists(treeSitterBuildSrc)) {
      await fs.copy(treeSitterBuildSrc, treeSitterBuildDest);
      console.log('✅ Copied tree-sitter build files');
    }

    // 复制 tree-sitter-cpp 模块
    const treeSitterCppSrc = './node_modules/tree-sitter-cpp';
    const treeSitterCppDest = path.join(bundleDir, 'node_modules/tree-sitter-cpp');
    await fs.ensureDir(treeSitterCppDest);
    
    // 复制主要文件
    await fs.copy(path.join(treeSitterCppSrc, 'package.json'), path.join(treeSitterCppDest, 'package.json'));
    
    // 复制 bindings 目录
    const bindingsSrc = path.join(treeSitterCppSrc, 'bindings');
    const bindingsDest = path.join(treeSitterCppDest, 'bindings');
    if (await fs.pathExists(bindingsSrc)) {
      await fs.copy(bindingsSrc, bindingsDest);
      console.log('✅ Copied tree-sitter-cpp bindings');
    }
    
    // 复制 tree-sitter-cpp 编译文件
    const treeSitterCppBuildSrc = path.join(treeSitterCppSrc, 'build');
    const treeSitterCppBuildDest = path.join(treeSitterCppDest, 'build');
    if (await fs.pathExists(treeSitterCppBuildSrc)) {
      await fs.copy(treeSitterCppBuildSrc, treeSitterCppBuildDest);
      console.log('✅ Copied tree-sitter-cpp build files');
    }

    // 复制 grammar.js（可能需要）
    const grammarSrc = path.join(treeSitterCppSrc, 'grammar.js');
    const grammarDest = path.join(treeSitterCppDest, 'grammar.js');
    if (await fs.pathExists(grammarSrc)) {
      await fs.copy(grammarSrc, grammarDest);
      console.log('✅ Copied tree-sitter-cpp grammar');
    }

    // 4. 复制 ninja 工具（如果存在）
    console.log('📦 Copying ninja build tool...');
    const ninjaSrc = './ninja';
    const ninjaDest = path.join(bundleDir, 'ninja');
    if (await fs.pathExists(ninjaSrc)) {
      await fs.copy(ninjaSrc, ninjaDest);
      console.log('✅ Copied ninja build tool');
    } else {
      console.log('ℹ️  Ninja not found in ./ninja directory');
    }

    // 5. 创建启动脚本
    console.log('📦 Creating launch script...');
    const launchScript = `#!/usr/bin/env node
// Auto-generated launch script for aily-builder
const path = require('path');

// 设置模块查找路径，确保能找到原生模块
const originalResolveFilename = require.extensions['.node'] || require._extensions['.node'];
const bundleDir = __dirname;
const nodeModulesPath = path.join(bundleDir, 'node_modules');

// 添加 bundle 目录的 node_modules 到模块查找路径
if (!module.paths.includes(nodeModulesPath)) {
  module.paths.unshift(nodeModulesPath);
}

// 启动主程序
require('./aily-builder.js');
`;

    await fs.writeFile(path.join(bundleDir, 'index.js'), launchScript);

    // 设置执行权限（Unix/Linux）
    if (process.platform !== 'win32') {
      await fs.chmod(path.join(bundleDir, 'index.js'), '755');
      await fs.chmod(path.join(bundleDir, 'aily-builder.js'), '755');
    }

    // 6. 创建 package.json
    console.log('📦 Creating package.json...');
    const bundlePackageJson = {
      name: 'aily-builder-bundle',
      version: '1.0.0',
      description: 'Complete aily-builder bundle with native dependencies',
      main: 'index.js',
      bin: {
        'aily': 'index.js'
      },
      engines: {
        node: '>=16'
      }
    };
    
    await fs.writeFile(
      path.join(bundleDir, 'package.json'), 
      JSON.stringify(bundlePackageJson, null, 2)
    );

    // 7. 创建使用说明
    const readmeContent = `# Aily Builder Complete Bundle

This is a complete bundle of aily-builder including all native dependencies.

## Usage

\`\`\`bash
# Run directly
node index.js [command] [options]

# Or if you have the bundle in PATH
aily [command] [options]
\`\`\`

## Examples

\`\`\`bash
# Show help
node index.js --help

# Compile Arduino sketch
node index.js compile examples/blink.ino --verbose

# Show version
node index.js --version
\`\`\`

## Files included

- \`index.js\` - Launch script
- \`aily-builder.js\` - Main bundled application
- \`node_modules/tree-sitter/\` - Tree-sitter parser with native bindings
- \`node_modules/tree-sitter-cpp/\` - C++ language grammar for tree-sitter

## System Requirements

- Node.js >= 16
- The native modules are compiled for ${process.platform}-${process.arch}
`;

    await fs.writeFile(path.join(bundleDir, 'README.md'), readmeContent);

    // 显示统计信息
    console.log('✅ Complete bundle created successfully!');
    console.log(`📁 Output directory: ${bundleDir}`);
    
    // 计算总大小
    const bundleStats = await getBundleStats(bundleDir);
    console.log(`📦 Total bundle size: ${bundleStats.totalSizeFormatted}`);
    console.log(`📊 Files included: ${bundleStats.fileCount}`);
    
    console.log('\n🚀 To test the bundle:');
    console.log(`   cd ${bundleDir}`);
    console.log('   node index.js --help');
    
  } catch (error) {
    console.error('❌ Bundle creation failed:', error);
    process.exit(1);
  }
}

// 压缩版本
async function bundleWithNativeMinified() {
  try {
    console.log('📦 Building minified complete bundle...');
    
    // 先创建标准版本
    await bundleWithNative();
    
    // 然后创建压缩版本
    const bundleDir = './dist/bundle-min';
    await fs.ensureDir(bundleDir);
    
    // 压缩版本的主文件
    const result = await esbuild.build({
      entryPoints: ['./dist/main.js'],
      bundle: true,
      platform: 'node',
      target: 'node16',
      format: 'cjs',
      outfile: path.join(bundleDir, 'aily-builder.js'),
      external: [
        'tree-sitter',
        'tree-sitter-cpp',
      ],
      banner: {
        js: process.platform === 'win32' ? '' : '#!/usr/bin/env node\n'
      },
      minify: true,
      sourcemap: false,
      logLevel: 'info'
    });
    
    // 复制原生模块（与标准版本相同）
    await fs.copy('./dist/bundle/node_modules', path.join(bundleDir, 'node_modules'));
    await fs.copy('./dist/bundle/index.js', path.join(bundleDir, 'index.js'));
    await fs.copy('./dist/bundle/package.json', path.join(bundleDir, 'package.json'));
    await fs.copy('./dist/bundle/README.md', path.join(bundleDir, 'README.md'));
    
    console.log('✅ Minified complete bundle created!');
    console.log(`📁 Output directory: ${bundleDir}`);
    
  } catch (error) {
    console.error('❌ Minified bundle creation failed:', error);
    process.exit(1);
  }
}

// 获取包统计信息
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

// 根据命令行参数决定构建类型
const arg = process.argv[2];
if (arg === '--minify' || arg === '-m') {
  bundleWithNativeMinified();
} else if (arg === '--both' || arg === '-b') {
  bundleWithNative().then(() => bundleWithNativeMinified());
} else {
  bundleWithNative();
}