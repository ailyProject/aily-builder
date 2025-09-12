const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// 构建单个 JS 文件
async function bundle() {
  try {
    // 首先检查 dist/main.js 是否存在，如果不存在先编译 TypeScript
    const distMainPath = './dist/main.js';
    if (!fs.existsSync(distMainPath)) {
      console.log('❌ dist/main.js not found. Please run "npm run build" first.');
      process.exit(1);
    }

    console.log('📦 Building single JS bundle...');
    
    const result = await esbuild.build({
      entryPoints: ['./dist/main.js'],
      bundle: true,
      platform: 'node',
      target: 'node16',
      format: 'cjs',
      outfile: './dist/aily-builder-bundle.js',
      external: [
        // 排除一些 Node.js 原生模块和二进制依赖
        'tree-sitter',
        'tree-sitter-cpp',
      ],
      banner: {
        js: process.platform === 'win32' ? '' : '#!/usr/bin/env node\n'
      },
      minify: false, // 保持可读性，可以设置为 true 来压缩
      sourcemap: false,
      metafile: true,
      logLevel: 'info'
    });

    // 确保输出文件具有执行权限
    if (process.platform !== 'win32') {
      fs.chmodSync('./dist/aily-builder-bundle.js', '755');
    }

    console.log('✅ Bundle created successfully!');
    console.log('📁 Output: ./dist/aily-builder-bundle.js');
    
    // 显示打包分析信息
    if (result.metafile) {
      const analysis = await esbuild.analyzeMetafile(result.metafile);
      console.log('\n📊 Bundle analysis:');
      console.log(analysis);
    }

    // 显示文件大小
    const stats = fs.statSync('./dist/aily-builder-bundle.js');
    const sizeInMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`📦 Bundle size: ${sizeInMB} MB`);
    
  } catch (error) {
    console.error('❌ Bundle failed:', error);
    process.exit(1);
  }
}

// 构建压缩版本
async function bundleMinified() {
  try {
    const distMainPath = './dist/main.js';
    if (!fs.existsSync(distMainPath)) {
      console.log('❌ dist/main.js not found. Please run "npm run build" first.');
      process.exit(1);
    }

    console.log('📦 Building minified JS bundle...');
    
    await esbuild.build({
      entryPoints: ['./dist/main.js'],
      bundle: true,
      platform: 'node',
      target: 'node16',
      format: 'cjs',
      outfile: './dist/aily-builder-bundle.min.js',
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

    // 确保输出文件具有执行权限
    if (process.platform !== 'win32') {
      fs.chmodSync('./dist/aily-builder-bundle.min.js', '755');
    }

    console.log('✅ Minified bundle created successfully!');
    console.log('📁 Output: ./dist/aily-builder-bundle.min.js');
    
    // 显示文件大小
    const stats = fs.statSync('./dist/aily-builder-bundle.min.js');
    const sizeInMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`📦 Minified bundle size: ${sizeInMB} MB`);
    
  } catch (error) {
    console.error('❌ Minified bundle failed:', error);
    process.exit(1);
  }
}

// 根据命令行参数决定构建类型
const arg = process.argv[2];
if (arg === '--minify' || arg === '-m') {
  bundleMinified();
} else if (arg === '--both' || arg === '-b') {
  bundle().then(() => bundleMinified());
} else {
  bundle();
}