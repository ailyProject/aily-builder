import fs from 'fs-extra';
import path from 'path';
import { Logger } from './utils/Logger';
import { Dependency } from './DependencyAnalyzer';

export interface NinjaRule {
  name: string;
  command: string;
  description?: string;
  depfile?: string;
  deps?: string;
  msvc_deps_prefix?: string;
  restat?: boolean;
}

export interface NinjaBuild {
  outputs: string[];
  rule: string;
  inputs?: string[];
  implicit?: string[];
  orderOnly?: string[];
  variables?: { [key: string]: string };
}

export interface NinjaFile {
  rules: NinjaRule[];
  builds: NinjaBuild[];
  variables: { [key: string]: string };
  pools?: { [name: string]: number };
}

export interface NinjaOptions {
  dependencies: Dependency[];
  compileConfig: any;
  buildPath: string;
  jobs: number;
  skipExistingObjects?: boolean; // 新增：是否跳过已存在的对象文件
}

export class NinjaGenerator {
  private logger: Logger;
  private dependencies: Dependency[];
  private compileConfig: any;
  private buildPath: string;
  private ninjaFile: NinjaFile;
  private objectFiles: string[] = [];
  private skipExistingObjects: boolean = false;

  constructor(logger: Logger) {
    this.logger = logger;
    this.ninjaFile = {
      rules: [],
      builds: [],
      variables: {},
      pools: {}
    };
  }

  async generateNinjaFile(options: NinjaOptions): Promise<string> {
    try {
      this.dependencies = options.dependencies;
      this.compileConfig = options.compileConfig;
      this.buildPath = options.buildPath;
      this.skipExistingObjects = options.skipExistingObjects || false;

      // console.log(this.compileConfig);

      // 设置ninja pool限制并发数
      this.ninjaFile.pools = {
        sketch_pool: 1,  // sketch 专用池，单线程优先编译
        compile_pool: options.jobs
      };

      // 设置全局变量
      this.setupGlobalVariables();

      // 生成编译规则
      this.generateRules();

      // 生成构建目标
      await this.generateBuilds();

      // 生成链接目标
      this.generateLinkTargets();

      // 写入ninja文件
      const ninjaFilePath = path.join(this.buildPath, 'build.ninja');
      await this.writeNinjaFile(ninjaFilePath);

      return ninjaFilePath;

    } catch (error) {
      console.log(`生成Ninja文件失败: ${error.message}`);
      return null;
    }
  }

  private setupGlobalVariables(): void {
    // 设置编译器路径变量
    this.ninjaFile.variables = {
      cpp_compiler: this.compileConfig.compiler.cpp,
      c_compiler: this.compileConfig.compiler.c,
      ar: this.compileConfig.compiler.ar,
      ld: this.compileConfig.compiler.ld,
      objcopy: this.compileConfig.compiler.objcopy,
      build_path: this.buildPath.replace(/\\/g, '/'),
      sketch_name: process.env['SKETCH_NAME'] || 'sketch'
    };

    // 添加编译器路径到PATH
    if (process.env['COMPILER_PATH']) {
      this.ninjaFile.variables.compiler_path = process.env['COMPILER_PATH'].replace(/\\/g, '/');
    }

    // 为依赖路径创建变量
    this.dependencies.forEach(dep => {
      const varName = `${dep.name.replace(/[^a-zA-Z0-9]/g, '_')}_path`;
      this.ninjaFile.variables[varName] = dep.path.replace(/\\/g, '/');
    });
  }

  private generateRules(): void {
    // C++编译规则
    this.ninjaFile.rules.push({
      name: 'cpp_compile',
      command: this.formatCommand(this.compileConfig.args.cpp, {
        compiler: '$cpp_compiler',
        input: '$in',
        output: '$out'
      }),
      description: 'Compiling C++ $in',
      deps: 'gcc',
      depfile: '$out.d'
    });

    // C编译规则
    this.ninjaFile.rules.push({
      name: 'c_compile',
      command: this.formatCommand(this.compileConfig.args.c, {
        compiler: '$c_compiler',
        input: '$in',
        output: '$out'
      }),
      description: 'Compiling C $in',
      deps: 'gcc',
      depfile: '$out.d'
    });

    // 汇编编译规则
    this.ninjaFile.rules.push({
      name: 's_compile',
      command: this.formatCommand(this.compileConfig.args.s, {
        compiler: '$c_compiler',
        input: '$in',
        output: '$out'
      }),
      description: 'Assembling $in',
      deps: 'gcc',
      depfile: '$out.d'
    });

    // 归档规则
    this.ninjaFile.rules.push({
      name: 'archive',
      command: '$ar rcs $out $in',
      description: 'Archiving $out'
    });

    // 链接规则
    this.ninjaFile.rules.push({
      name: 'link',
      command: this.formatCommand(this.compileConfig.args.ld, {
        compiler: '$ld',
        inputs: '$in',
        output: '$out',
        ldflags: '$ldflags'
      }),
      description: 'Linking $out'
    });

    // objcopy规则
    if (this.compileConfig.args.hex) {
      this.ninjaFile.rules.push({
        name: 'objcopy_hex',
        command: this.formatCommand(this.compileConfig.args.hex, {
          compiler: '$objcopy',
          input: '$in',
          output: '$out'
        }),
        description: 'Generating HEX $out'
      });
    }

    if (this.compileConfig.args.eep) {
      this.ninjaFile.rules.push({
        name: 'objcopy_eep',
        command: this.formatCommand(this.compileConfig.args.eep, {
          compiler: '$objcopy',
          input: '$in',
          output: '$out'
        }),
        description: 'Generating EEP $out'
      });
    }

    if (this.compileConfig.compiler.bin) {
      this.ninjaFile.rules.push({
        name: 'generate_bin',
        command: this.formatCommand(this.compileConfig.args.bin, {
          compiler: this.compileConfig.compiler.bin,
          input: '$in',
          output: '$out'
        }),
        description: 'Generating BIN $out'
      });
    }
  }

  private async generateBuilds(): Promise<void> {
    const archiveGroups = new Map<string, string[]>();
    const processedFiles = new Set<string>(); // 避免重复处理同一个文件

    // 1. 优先生成sketch编译目标 - 确保用户代码最先编译
    const sketchBuild = await this.createCompileBuild(
      process.env['SKETCH_PATH']!,
      'sketch',
      'sketch'
    );
    if (sketchBuild) {
      // 为sketch构建添加最高优先级，确保最先执行
      sketchBuild.variables = {
        ...sketchBuild.variables,
        pool: 'sketch_pool'  // 使用专用的sketch池确保优先编译
      };
      // 将sketch构建插入到builds数组的最前面
      this.ninjaFile.builds.unshift(sketchBuild);
      this.objectFiles.push(sketchBuild.outputs[0]);
    } else {
      // 即使跳过编译，也要将对象文件添加到列表中（用于链接）
      const sketchFileName = path.basename(process.env['SKETCH_PATH']!);
      const objectFile = path.join('sketch', `${sketchFileName}.o`);
      this.objectFiles.push(objectFile);
    }

    // 2. 生成依赖库和core的编译目标
    for (const dependency of this.dependencies) {
      const groupObjects: string[] = [];

      for (const file of dependency.includes) {
        // 避免重复处理同一个文件
        if (processedFiles.has(file)) {
          continue;
        }
        processedFiles.add(file);

        const build = await this.createCompileBuild(file, dependency.type, dependency.name);
        if (build) {
          this.ninjaFile.builds.push(build);
          groupObjects.push(build.outputs[0]);
        } else {
          // 即使跳过编译，也要将对象文件添加到归档组中
          const fileName = path.basename(file);
          let objectFile: string;
          if (dependency.type === 'library') {
            objectFile = path.join(dependency.type, dependency.name, `${fileName}.o`);
          } else {
            objectFile = path.join(dependency.type, `${fileName}.o`);
          }
          groupObjects.push(objectFile);
        }
      }

      if (dependency.type !== 'sketch' && groupObjects.length > 0) {
        // variant类型归并到core中
        if (dependency.type === 'variant') {
          // // 找到core类型的依赖并将variant的对象文件添加到其中
          // const coreDependency = this.dependencies.find(d => d.type === 'core');
          // if (coreDependency) {
          //   if (archiveGroups.has(coreDependency.name)) {
          //     archiveGroups.get(coreDependency.name)!.push(...groupObjects);
          //   } else {
          //     archiveGroups.set(coreDependency.name, groupObjects);
          //   }
          // } else {
          // 如果没有找到core依赖，则创建一个core归档组
          if (archiveGroups.has('core')) {
            archiveGroups.get('core')!.push(...groupObjects);
          } else {
            archiveGroups.set('core', groupObjects);
          }
          // }
        } else {
          archiveGroups.set(dependency.name, groupObjects);
        }
      }
    }

    // 3. 生成归档目标
    for (const [dependencyName, objects] of archiveGroups) {
      const dependency = this.dependencies.find(d => d.name === dependencyName);
      if (!dependency) continue;

      let archivePath: string;
      if (dependency.type === 'core' || dependencyName === 'core') {
        archivePath = 'core.a';
      } else {
        archivePath = `${dependencyName}.a`;
        this.objectFiles.push(archivePath);
      }

      // 检查归档文件是否需要重新生成
      let needsRebuild = true;
      if (this.skipExistingObjects) {
        const fullArchivePath = path.join(this.buildPath, archivePath);
        if (await fs.pathExists(fullArchivePath)) {
          try {
            const archiveStat = await fs.stat(fullArchivePath);
            // 检查所有对象文件是否都存在且比归档文件旧
            const objectChecks = await Promise.all(objects.map(async (obj) => {
              const fullObjPath = path.join(this.buildPath, obj);
              if (await fs.pathExists(fullObjPath)) {
                const objStat = await fs.stat(fullObjPath);
                return objStat.mtime <= archiveStat.mtime;
              }
              return false;
            }));

            if (objectChecks.every(check => check)) {
              needsRebuild = false;
              this.logger.debug(`Skipping archive ${archivePath}: up to date`);
            }
          } catch (error) {
            this.logger.debug(`Cannot check archive timestamps for ${archivePath}, will rebuild`);
          }
        }
      }

      if (needsRebuild) {
        const archiveBuild: NinjaBuild = {
          outputs: [archivePath],
          rule: 'archive',
          inputs: objects
        };

        this.ninjaFile.builds.push(archiveBuild);
      }
    }
  }

  private async createCompileBuild(
    sourceFile: string,
    type: 'sketch' | 'library' | 'core' | 'variant',
    dependencyName: string
  ): Promise<NinjaBuild | null> {
    const ext = path.extname(sourceFile);
    const fileName = path.basename(sourceFile);

    let objectFile: string;
    let rule: string;

    // 确定对象文件路径（使用相对路径）
    if (type === 'library') {
      // 检查是否需要添加上级目录名称以避免同名文件冲突
      const sourceDir = path.dirname(sourceFile);
      const parentDirName = path.basename(sourceDir);
      
      // 如果上级目录不是库的根目录（即存在架构或其他子目录），则添加目录前缀
      const dep = this.dependencies.find(d => d.name === dependencyName);
      if (dep && sourceDir !== dep.path && parentDirName !== dependencyName) {
        // 使用上级目录名称作为前缀，避免同名文件冲突
        const prefixedFileName = `${parentDirName}_${fileName}`;
        objectFile = path.join(type, dependencyName, `${prefixedFileName}.o`);
      } else {
        objectFile = path.join(type, dependencyName, `${fileName}.o`);
      }
    } else {
      objectFile = path.join(type, `${fileName}.o`);
    }

    // 如果启用了跳过已存在对象文件的选项，检查文件是否已存在
    if (this.skipExistingObjects) {
      const fullObjectPath = path.join(this.buildPath, objectFile);
      if (await fs.pathExists(fullObjectPath)) {
        // 检查对象文件是否比源文件新
        try {
          const [sourceStat, objectStat] = await Promise.all([
            fs.stat(sourceFile),
            fs.stat(fullObjectPath)
          ]);

          if (objectStat.mtime >= sourceStat.mtime) {
            this.logger.debug(`Skipping ${objectFile}: object file is up to date`);
            return null; // 跳过这个构建目标
          }
        } catch (error) {
          // 如果无法获取文件状态，继续构建
          this.logger.debug(`Cannot check file timestamps for ${objectFile}, will rebuild`);
        }
      }
    }

    // 确定编译规则
    switch (ext) {
      case '.ino':
      case '.cpp':
        rule = 'cpp_compile';
        break;
      case '.c':
        rule = 'c_compile';
        break;
      case '.s':
      case '.S':
        rule = 's_compile';
        break;
      default:
        throw new Error(`Unsupported file extension: ${ext}`);
    }

    // 将源文件路径转换为相对于build目录的路径或使用变量
    const dep = this.dependencies.find(d => sourceFile.startsWith(d.path));
    let sourcePathForNinja: string;
    if (dep) {
      const varName = `${dep.name.replace(/[^a-zA-Z0-9]/g, '_')}_path`;
      const relativePath = path.relative(dep.path, sourceFile).replace(/\\/g, '/');
      sourcePathForNinja = `$${varName}/${relativePath}`;
    } else {
      sourcePathForNinja = path.relative(this.buildPath, sourceFile).replace(/\\/g, '/');
    }

    return {
      outputs: [objectFile],
      rule,
      inputs: [sourcePathForNinja],
      variables: {
        pool: 'compile_pool'
      }
    };
  }

  private generateLinkTargets(): void {
    const sketchName = process.env['SKETCH_NAME'] || 'sketch';
    const elfFile = `${sketchName}.elf`;
    const hexFile = `${sketchName}.hex`;
    const eepFile = `${sketchName}.eep`;
    const binFile = `${sketchName}.bin`;

    // 准备预编译库标志
    const precompiledLibFlags: string[] = [];
    this.dependencies.forEach(dep => {
      if (dep.type === 'library' && dep.others.length > 0) {
        dep.others.forEach(libPath => {
          const libDir = path.dirname(libPath);
          const libName = path.basename(libPath, '.a').replace(/^lib/, '');
          precompiledLibFlags.push(`-L"${libDir}" -l${libName}`);
        });
      }
    });

    // 链接目标
    const linkBuild: NinjaBuild = {
      outputs: [elfFile],
      rule: 'link',
      inputs: this.objectFiles,
      implicit: ['core.a'],
      variables: precompiledLibFlags.length > 0 ? {
        ldflags: precompiledLibFlags.join(' ')
      } : undefined
    };

    this.ninjaFile.builds.push(linkBuild);

    // 生成hex和eep文件（AVR）
    if (this.compileConfig.args.eep) {
      this.ninjaFile.builds.push({
        outputs: [eepFile],
        rule: 'objcopy_eep',
        inputs: [elfFile]
      });
    }
    if (this.compileConfig.args.hex) {
      this.ninjaFile.builds.push({
        outputs: [hexFile],
        rule: 'objcopy_hex',
        inputs: [elfFile]
      });
    }

    // 生成bin文件（ESP32）
    if (this.compileConfig.compiler.bin) {
      this.ninjaFile.builds.push({
        outputs: [binFile],
        rule: 'generate_bin',
        inputs: [elfFile]
      });
    }
  }

  private formatCommand(argsTemplate: string, replacements: { [key: string]: string }): string {
    // console.log(argsTemplate);
    // console.log(replacements);

    let command = argsTemplate;

    // 替换include路径
    if (command.includes('%INCLUDE_PATHS%')) {
      const includeArgs = this.dependencies
        .map(dep => {
          const varName = `${dep.name.replace(/[^a-zA-Z0-9]/g, '_')}_path`;
          return `-I$${varName}`;
        })
        .join(' ');
      command = command.replace(/%INCLUDE_PATHS%/g, includeArgs);
    }

    // 替换输入输出文件
    command = command.replace(/"%SOURCE_FILE_PATH%"/g, replacements.input || '$in');
    command = command.replace(/"%OBJECT_FILE_PATH%"/g, replacements.output || '$out');

    // 处理链接时的对象文件路径
    if (command.includes('%OBJECT_FILE_PATHS%')) {
      const objectPattern = replacements.inputs || '$in';
      command = command.replace(/%OBJECT_FILE_PATHS%/g, `-Wl,--whole-archive ${objectPattern} -Wl,--no-whole-archive`);
    }

    // 处理预编译库
    if (command.includes('%LD_FLAGS%')) {
      command = command.replace(/%LD_FLAGS%/g, replacements.ldflags || '');
    }

    // 替换固定路径模式（用于objcopy）
    const sketchName = process.env['SKETCH_NAME'] || 'sketch';
    command = command.replace(new RegExp(`"[^"]*/${sketchName}\\.elf"`, 'g'), `${sketchName}.elf`);
    command = command.replace(new RegExp(`"[^"]*/${sketchName}\\.hex"`, 'g'), `${sketchName}.hex`);
    command = command.replace(new RegExp(`"[^"]*/${sketchName}\\.eep"`, 'g'), `${sketchName}.eep`);
    command = command.replace(new RegExp(`"[^"]*/${sketchName}\\.bin"`, 'g'), `${sketchName}.bin`);

    // 最后添加编译器命令
    if (replacements.compiler) {
      command = `${replacements.compiler} ${command}`;
    }

    // 清理多余的空格
    return command.replace(/\s+/g, ' ').trim();
  }

  private async writeNinjaFile(filePath: string): Promise<void> {
    const content: string[] = [];

    // 写入变量
    content.push('# Global variables');
    for (const [key, value] of Object.entries(this.ninjaFile.variables)) {
      content.push(`${key} = ${value}`);
    }
    content.push('');

    // 写入池
    if (this.ninjaFile.pools) {
      content.push('# Pools');
      for (const [name, depth] of Object.entries(this.ninjaFile.pools)) {
        content.push(`pool ${name}`);
        content.push(`  depth = ${depth}`);
      }
      content.push('');
    }

    // 写入规则
    content.push('# Rules');
    for (const rule of this.ninjaFile.rules) {
      content.push(`rule ${rule.name}`);
      content.push(`  command = ${rule.command}`);
      if (rule.description) {
        content.push(`  description = ${rule.description}`);
      }
      if (rule.depfile) {
        content.push(`  depfile = ${rule.depfile}`);
      }
      if (rule.deps) {
        content.push(`  deps = ${rule.deps}`);
      }
      if (rule.restat) {
        content.push(`  restat = true`);
      }
      content.push('');
    }

    // 写入构建目标
    content.push('# Build targets');
    for (const build of this.ninjaFile.builds) {
      const inputs = build.inputs || [];
      const implicit = (build.implicit || []).map(i => `| ${i}`);
      const orderOnly = (build.orderOnly || []).map(o => `|| ${o}`);

      // 将所有路径转换为Unix风格（ninja要求）
      const outputs = build.outputs.map(o => o.replace(/\\/g, '/'));
      const unixInputs = inputs.map(i => i.replace(/\\/g, '/'));
      const unixImplicit = implicit.map(i => i.replace(/\\/g, '/'));
      const unixOrderOnly = orderOnly.map(o => o.replace(/\\/g, '/'));

      const allInputs = [...unixInputs, ...unixImplicit, ...unixOrderOnly];

      // 使用 $和 变量来避免长路径问题
      const inputsStr = allInputs.join(' ');

      if (inputsStr.length > 200) {
        // 使用续行符
        content.push(`build ${outputs.join(' ')}: ${build.rule} $`);
        content.push(`    ${inputsStr}`);
      } else {
        content.push(`build ${outputs.join(' ')}: ${build.rule} ${inputsStr}`);
      }

      if (build.variables) {
        for (const [key, value] of Object.entries(build.variables)) {
          content.push(`  ${key} = ${value}`);
        }
      }
      content.push('');
    }

    // 写入默认目标
    const sketchName = process.env['SKETCH_NAME'] || 'sketch';
    let defaultTargets: string[] = [];
    if (this.compileConfig.args.hex) {
      defaultTargets.push(`${sketchName}.hex`);
    }
    if (this.compileConfig.args.eep) {
      defaultTargets.push(`${sketchName}.eep`);
    }
    if (this.compileConfig.compiler.bin) {
      defaultTargets.push(`${sketchName}.bin`);
    } else {
      defaultTargets.push(`${sketchName}.elf`);
    }
    content.push(`default ${defaultTargets.join(' ')}`);
    content.push(''); // 确保文件末尾有换行符

    await fs.writeFile(filePath, content.join('\n'));
    this.logger.verbose(`Generated ninja file: ${filePath}`);
  }

  getObjectFiles(): string[] {
    return this.objectFiles;
  }
}
