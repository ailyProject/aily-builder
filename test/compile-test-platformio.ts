import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

interface CompileResult {
  success: boolean;
  duration: number;
  output: string;
  binarySize?: number;
  flashUsage?: {
    used: number;
    total: number;
    percentage: number;
  };
  ramUsage?: {
    used: number;
    total: number;
    percentage: number;
  };
  buildFiles?: {
    count: number;
    totalSize: number;
  };
  error?: string;
}

interface TestConfig {
  projectPath: string;  // 项目目录路径
  board: string;
  jobs: number;
  verbose: boolean;
  librariesPath?: string[];
  platformioPath?: string; // PlatformIO项目路径
  buildProperties?: string[]; // 构建属性参数
}

class ArduinoCompileTest {
  private config: TestConfig;
  
  constructor(config: TestConfig) {
    this.config = config;
  }

  private async executeCommand(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      console.log(chalk.gray(`> ${command} ${args.join(' ')}`));
      
      const child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      });

      let output = '';
      let errorOutput = '';

      child.stdout?.on('data', (data) => {
        const text = data.toString();
        output += text;
        // 实时输出（去掉ANSI颜色码以避免显示问题）
        process.stdout.write(chalk.gray(text.replace(/\x1b\[[0-9;]*m/g, '')));
      });

      child.stderr?.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        // 实时输出错误信息
        process.stderr.write(chalk.red(text.replace(/\x1b\[[0-9;]*m/g, '')));
      });

      const timer = options.timeout ? setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timeout after ${options.timeout}ms`));
      }, options.timeout) : null;

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          output: output + errorOutput,
          exitCode: code || 0
        });
      });

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
    });
  }

  private parseMemoryUsage(output: string): { flashUsage?: any; ramUsage?: any } {
    const result: any = {};
    
    // 解析Flash使用量
    const flashMatch = output.match(/Sketch uses (\d+) bytes \((\d+)%\) of program storage space\. Maximum is (\d+) bytes/);
    if (flashMatch) {
      result.flashUsage = {
        used: parseInt(flashMatch[1]),
        percentage: parseInt(flashMatch[2]),
        total: parseInt(flashMatch[3])
      };
    }
    
    // 解析RAM使用量
    const ramMatch = output.match(/Global variables use (\d+) bytes \((\d+)%\) of dynamic memory, leaving (\d+) bytes for local variables\. Maximum is (\d+) bytes/);
    if (ramMatch) {
      const used = parseInt(ramMatch[1]);
      const total = parseInt(ramMatch[4]);
      result.ramUsage = {
        used,
        total,
        percentage: Math.round((used / total) * 100)
      };
    }
    
    return result;
  }

  // PlatformIO的内存使用量解析可能格式不同
  private parsePlatformIOMemoryUsage(output: string): { flashUsage?: any; ramUsage?: any } {
    const result: any = {};
    
    // PlatformIO常见的输出格式
    // RAM:   [==        ]  XX.X% (used XXXX bytes from XXXXX bytes)
    // Flash: [======    ]  XX.X% (used XXXXX bytes from XXXXXX bytes)
    
    const ramMatch = output.match(/RAM:\s*\[.*?\]\s*(\d+\.?\d*)%.*?used\s+(\d+)\s+bytes.*?from\s+(\d+)\s+bytes/i);
    if (ramMatch) {
      result.ramUsage = {
        used: parseInt(ramMatch[2]),
        total: parseInt(ramMatch[3]),
        percentage: parseFloat(ramMatch[1])
      };
    }
    
    const flashMatch = output.match(/Flash:\s*\[.*?\]\s*(\d+\.?\d*)%.*?used\s+(\d+)\s+bytes.*?from\s+(\d+)\s+bytes/i);
    if (flashMatch) {
      result.flashUsage = {
        used: parseInt(flashMatch[2]),
        total: parseInt(flashMatch[3]),
        percentage: parseFloat(flashMatch[1])
      };
    }
    
    // 如果没有找到PlatformIO格式，尝试Arduino格式
    if (!result.flashUsage) {
      const arduinoFlashMatch = output.match(/Sketch uses (\d+) bytes \((\d+)%\) of program storage space\. Maximum is (\d+) bytes/);
      if (arduinoFlashMatch) {
        result.flashUsage = {
          used: parseInt(arduinoFlashMatch[1]),
          percentage: parseInt(arduinoFlashMatch[2]),
          total: parseInt(arduinoFlashMatch[3])
        };
      }
    }
    
    if (!result.ramUsage) {
      const arduinoRamMatch = output.match(/Global variables use (\d+) bytes \((\d+)%\) of dynamic memory, leaving (\d+) bytes for local variables\. Maximum is (\d+) bytes/);
      if (arduinoRamMatch) {
        const used = parseInt(arduinoRamMatch[1]);
        const total = parseInt(arduinoRamMatch[4]);
        result.ramUsage = {
          used,
          total,
          percentage: Math.round((used / total) * 100)
        };
      }
    }
    
    return result;
  }

  private getBuildFileStats(buildPath: string): { count: number; totalSize: number } {
    if (!fs.existsSync(buildPath)) {
      return { count: 0, totalSize: 0 };
    }
    
    let count = 0;
    let totalSize = 0;
    
    const walkDir = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          walkDir(filePath);
        } else {
          count++;
          totalSize += stat.size;
        }
      }
    };
    
    walkDir(buildPath);
    return { count, totalSize };
  }

  private findBinaryFile(buildPath: string, extensions: string[]): number | undefined {
    if (!fs.existsSync(buildPath)) return undefined;
    
    const findFile = (dir: string): string | undefined => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          const found = findFile(filePath);
          if (found) return found;
        } else {
          for (const ext of extensions) {
            if (file.endsWith(ext)) {
              return filePath;
            }
          }
        }
      }
      return undefined;
    };
    
    const binaryFile = findFile(buildPath);
    if (binaryFile && fs.existsSync(binaryFile)) {
      return fs.statSync(binaryFile).size;
    }
    return undefined;
  }

  async testAilyBuilder(): Promise<CompileResult> {
    console.log(chalk.cyan('\n🚀 测试 aily-builder...'));
    console.log(chalk.blue('确保Node.js 18版本激活...'));
    
    // 首先确保使用Node 18
    try {
      await this.executeCommand('fnm', ['use', '18'], { timeout: 10000 });
    } catch (error) {
      console.log(chalk.yellow('警告: 切换到Node 18失败，继续执行...'));
    }
    
    const startTime = Date.now();
    
    try {
      // 从项目目录中找到.ino文件
      const projectDir = path.resolve(this.config.projectPath);
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        throw new Error(`Project directory not found: ${projectDir}`);
      }
      
      const inoFile = this.findSketchFile(projectDir);
      if (!inoFile) {
        throw new Error(`No .ino file found in ${projectDir}`);
      }
      
      // 构建包含构建属性的FQBN
      let fqbnWithProperties = this.buildFQBNWithProperties(this.config.board, this.config.buildProperties);
      
      // aily-builder的FQBN只保留前三组数据（第三个:前的数据）
      const fqbnParts = fqbnWithProperties.split(':');
      if (fqbnParts.length > 3) {
        fqbnParts.length = 3; // 截取前三部分
        fqbnWithProperties = fqbnParts.join(':');
      }
      
      const args = [
        'D:\\codes\\aily-builder\\dist\\bundle-min\\index.js', 'compile', `"${inoFile}"`,
        // 'D:\\codes\\aily-builder\\main.ts', 'compile', `"${inoFile}"`,
        '--board', fqbnWithProperties,
        '--jobs', this.config.jobs.toString()
      ];
      
      args.push('--verbose');
      
      // 添加库路径支持
      if (this.config.librariesPath && this.config.librariesPath.length > 0) {
        for (const libPath of this.config.librariesPath) {
          args.push('--libraries-path', `"${libPath}"`);
        }
      }
      
      // 添加构建属性支持
      if (this.config.buildProperties && this.config.buildProperties.length > 0) {
        for (const property of this.config.buildProperties) {
          args.push('--build-property', property);
        }
      }
      
      console.log(chalk.cyan(`\n📋 aily-builder编译开始...\n`));
      
      const result = await this.executeCommand('ts-node', args, {
        cwd: process.cwd(),
        timeout: 1800000 // 30分钟超时
      });
      
      const duration = (Date.now() - startTime) / 1000;
      
      if (result.exitCode !== 0) {
        throw new Error(`aily-builder编译失败，退出代码 ${result.exitCode}`);
      }
      
      console.log(chalk.green(`\n✅ aily-builder编译完成，用时 ${duration.toFixed(2)}秒\n`));
      
      // 解析内存使用量
      const memoryUsage = this.parseMemoryUsage(result.output);
      
      // 获取构建文件统计
      const buildPath = path.join(path.dirname(inoFile), 'build');
      const buildFiles = this.getBuildFileStats(buildPath);
      
      // 查找二进制文件大小
      const binarySize = this.findBinaryFile(buildPath, ['.hex', '.bin', '.elf']);
      
      return {
        success: true,
        duration,
        output: result.output,
        binarySize,
        buildFiles,
        ...memoryUsage
      };
      
    } catch (error: any) {
      const duration = (Date.now() - startTime) / 1000;
      return {
        success: false,
        duration,
        output: error.stdout || '',
        error: error.message
      };
    }
  }

  async testArduinoCli(): Promise<CompileResult> {
    console.log(chalk.cyan('\n🛠️  测试 arduino-cli...'));
    
    const startTime = Date.now();
    
    try {
      // arduino-cli直接使用项目目录
      const projectDir = path.resolve(this.config.projectPath);
      
      if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
        throw new Error(`Project directory not found: ${projectDir}`);
      }
      
      // 验证项目目录中有对应的.ino文件
      const expectedInoFile = path.join(projectDir, `${path.basename(projectDir)}.ino`);
      if (!fs.existsSync(expectedInoFile)) {
        throw new Error(`Expected .ino file not found: ${expectedInoFile}`);
      }
      
      // 创建临时构建目录
      const buildDir = path.join(projectDir, 'build-arduino-cli');
      if (fs.existsSync(buildDir)) {
        try {
          fs.rmSync(buildDir, { recursive: true, force: true });
          // 等待文件系统完成删除操作
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.log(chalk.yellow('Warning: Could not fully clean build directory'));
        }
      }
      
      // 确保构建目录存在
      if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir, { recursive: true });
      }
      
      // 构建包含构建属性的FQBN
      let fqbnWithProperties = this.buildFQBNWithProperties(this.config.board, this.config.buildProperties);

      // // 这里的FQBN任然只截取前三组字符串的数据 及第三个:前的数据
      // const fqbnParts = fqbnWithProperties.split(':'); 
      // if (fqbnParts.length > 3) {
      //   fqbnParts.length = 3; // 截取前三部分
      //   fqbnWithProperties = fqbnParts.join(':');
      // }

      const args = [
        'compile',
        '--fqbn', fqbnWithProperties,
        `"${projectDir}"`
      ];
      
      args.push('--verbose');
      
      // 添加库路径支持
      if (this.config.librariesPath && this.config.librariesPath.length > 0) {
        for (const libPath of this.config.librariesPath) {
          args.push('--libraries', `"${libPath}"`);
        }
      }
      
      // 添加构建属性支持
      if (this.config.buildProperties && this.config.buildProperties.length > 0) {
        for (const property of this.config.buildProperties) {
          args.push('--build-property', property);
        }
      }
      
      console.log(chalk.cyan(`\n📋 arduino-cli编译开始...\n`));
      
      const result = await this.executeCommand('arduino-cli', args, {
        cwd: process.cwd(),
        timeout: 1800000 // 30分钟超时
      });
      
      const duration = (Date.now() - startTime) / 1000;
      
      if (result.exitCode !== 0) {
        throw new Error(`arduino-cli编译失败，退出代码 ${result.exitCode}`);
      }
      
      console.log(chalk.green(`\n✅ arduino-cli编译完成，用时 ${duration.toFixed(2)}秒\n`));
      
      // 解析内存使用量
      const memoryUsage = this.parseMemoryUsage(result.output);
      
      // 获取构建文件统计
      const buildFiles = this.getBuildFileStats(buildDir);
      
      // 查找二进制文件大小
      const binarySize = this.findBinaryFile(buildDir, ['.hex', '.bin', '.elf']);
      
      return {
        success: true,
        duration,
        output: result.output,
        binarySize,
        buildFiles,
        ...memoryUsage
      };
      
    } catch (error: any) {
      const duration = (Date.now() - startTime) / 1000;
      return {
        success: false,
        duration,
        output: error.stdout || '',
        error: error.message
      };
    }
  }

  async testPlatformIO(): Promise<CompileResult> {
    console.log(chalk.cyan('\n🔧 测试 PlatformIO...'));
    
    const startTime = Date.now();
    
    try {
      // 使用固定的PlatformIO项目路径
      const platformioProject = this.config.platformioPath || 'D:\\platformio\\blink_sketch';
      
      if (!fs.existsSync(platformioProject) || !fs.statSync(platformioProject).isDirectory()) {
        throw new Error(`PlatformIO项目目录未找到: ${platformioProject}`);
      }
      
      // 检查platformio.ini文件是否存在
      const platformioIni = path.join(platformioProject, 'platformio.ini');
      if (!fs.existsSync(platformioIni)) {
        throw new Error(`platformio.ini未找到: ${platformioProject}`);
      }
      
      // 清理之前的构建
      const buildDir = path.join(platformioProject, '.pio', 'build');
      if (fs.existsSync(buildDir)) {
        try {
          fs.rmSync(buildDir, { recursive: true, force: true });
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.log(chalk.yellow('Warning: Could not clean PlatformIO build directory'));
        }
      }
      
      const args = ['run'];
      
      if (this.config.verbose) {
        args.push('--verbose');
      }
      
      console.log(chalk.cyan(`\n📋 PlatformIO编译开始...\n`));
      
      const result = await this.executeCommand('C:\\Users\\LENOVO\\.platformio\\penv\\Scripts\\platformio.exe', args, {
        cwd: platformioProject,
        timeout: 1800000 // 30分钟超时
      });
      
      const duration = (Date.now() - startTime) / 1000;
      
      if (result.exitCode !== 0) {
        throw new Error(`PlatformIO编译失败，退出代码 ${result.exitCode}`);
      }
      
      console.log(chalk.green(`\n✅ PlatformIO编译完成，用时 ${duration.toFixed(2)}秒\n`));
      
      // 解析内存使用量 (PlatformIO输出格式可能不同)
      const memoryUsage = this.parsePlatformIOMemoryUsage(result.output);
      
      // 获取构建文件统计
      const buildFiles = this.getBuildFileStats(buildDir);
      
      // 查找二进制文件大小
      const binarySize = this.findBinaryFile(buildDir, ['.hex', '.bin', '.elf']);
      
      return {
        success: true,
        duration,
        output: result.output,
        binarySize,
        buildFiles,
        ...memoryUsage
      };
      
    } catch (error: any) {
      const duration = (Date.now() - startTime) / 1000;
      return {
        success: false,
        duration,
        output: error.stdout || '',
        error: error.message
      };
    }
  }

  private findSketchFile(sketchPath: string): string | undefined {
    const dir = path.resolve(sketchPath);
    if (!fs.existsSync(dir)) return undefined;
    
    if (fs.statSync(dir).isFile() && dir.endsWith('.ino')) {
      return dir;
    }
    
    if (fs.statSync(dir).isDirectory()) {
      const dirName = path.basename(dir);
      const expectedFile = path.join(dir, `${dirName}.ino`);
      if (fs.existsSync(expectedFile)) {
        return expectedFile;
      }
      
      // 查找任何.ino文件
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.ino')) {
          return path.join(dir, file);
        }
      }
    }
    
    return undefined;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  private formatMemoryUsage(usage: any): string {
    if (!usage) return 'N/A';
    return `${this.formatBytes(usage.used)} / ${this.formatBytes(usage.total)} (${usage.percentage}%)`;
  }

  private buildFQBNWithProperties(baseFQBN: string, buildProperties?: string[]): string {
    if (!buildProperties || buildProperties.length === 0) {
      return baseFQBN;
    }

    let fqbn = baseFQBN;
    const fqbnParams: string[] = [];

    // 处理各种构建属性到FQBN参数的映射
    for (const property of buildProperties) {
      if (property.startsWith('build.partitions=')) {
        const partitionValue = property.split('=')[1];
        fqbnParams.push(`PartitionScheme=${partitionValue}`);
      // } else if (property.startsWith('build.flash_freq=')) {
      //   const freqValue = property.split('=')[1];
      //   fqbnParams.push(`FlashFreq=${freqValue}`);
      } else if (property.startsWith('build.flash_mode=')) {
        const modeValue = property.split('=')[1];
        fqbnParams.push(`FlashMode=${modeValue}`);
      } else if (property.startsWith('build.flash_size=')) {
        const sizeValue = property.split('=')[1];
        // 只保留数字和M，去掉MB后缀
        const normalizedSize = sizeValue.replace(/MB$/i, 'M');
        fqbnParams.push(`FlashSize=${normalizedSize}`);
      } else if (property.startsWith('build.PSRAM=') || property.startsWith('build.psram=')) {
        const psramValue = property.split('=')[1];
        fqbnParams.push(`PSRAM=${psramValue}`);
      } else if (property.startsWith('upload.speed=')) {
        const speedValue = property.split('=')[1];
        fqbnParams.push(`UploadSpeed=${speedValue}`);
      } else if (property.startsWith('build.usb_mode=')) {
        const usbValue = property.split('=')[1];
        fqbnParams.push(`USBMode=${usbValue}`);
      } else if (property.startsWith('build.cdc_on_boot=')) {
        const cdcValue = property.split('=')[1];
        fqbnParams.push(`CDCOnBoot=${cdcValue}`);
      } else if (property.startsWith('build.msc_on_boot=')) {
        const mscValue = property.split('=')[1];
        fqbnParams.push(`MSCOnBoot=${mscValue}`);
      } else if (property.startsWith('build.dfu_on_boot=')) {
        const dfuValue = property.split('=')[1];
        fqbnParams.push(`DFUOnBoot=${dfuValue}`);
      } else if (property.startsWith('upload.mode=')) {
        const uploadValue = property.split('=')[1];
        fqbnParams.push(`UploadMode=${uploadValue}`);
      } else if (property.startsWith('build.f_cpu=')) {
        const cpuValue = property.split('=')[1];
        // 处理CPU频率格式，如240000000L -> 240
        const freqMhz = cpuValue.replace(/000000L?$/i, '');
        fqbnParams.push(`CPUFreq=${freqMhz}`);
      } else if (property.startsWith('build.debug_level=')) {
        const debugValue = property.split('=')[1];
        fqbnParams.push(`DebugLevel=${debugValue}`);
      } else if (property.startsWith('build.loop_core=')) {
        const loopValue = property.split('=')[1];
        fqbnParams.push(`LoopCore=${loopValue}`);
      } else if (property.startsWith('build.event_core=')) {
        const eventValue = property.split('=')[1];
        fqbnParams.push(`EventsCore=${eventValue}`);
      } else if (property.startsWith('build.erase_flash=')) {
        const eraseValue = property.split('=')[1];
        fqbnParams.push(`EraseFlash=${eraseValue}`);
      } else if (property.startsWith('debug.tool=')) {
        const jtagValue = property.split('=')[1];
        fqbnParams.push(`JTAGAdapter=${jtagValue}`);
      } else if (property.startsWith('build.zigbee_mode=')) {
        const zigbeeValue = property.split('=')[1];
        fqbnParams.push(`ZigbeeMode=${zigbeeValue}`);
      }
    }

    // 如果有FQBN参数，则添加到FQBN中
    if (fqbnParams.length > 0) {
      fqbn = `${baseFQBN}:${fqbnParams.join(',')}`;
    }

    return fqbn;
  }

  private async getSystemInfo(): Promise<{ cpu: string; totalRAM: string; freeRAM: string; platform: string; arch: string }> {
    try {
      // 获取基本系统信息
      const totalRAM = os.totalmem();
      const freeRAM = os.freemem();
      const platform = os.platform();
      const arch = os.arch();
      
      let cpuInfo = 'Unknown CPU';
      
      // 使用 Node.js 内置的os.cpus()方法获取CPU信息
      try {
        const cpus = os.cpus();
        if (cpus && cpus.length > 0) {
          // 直接使用CPU型号名称，去掉不必要的空格和重复信息
          let cpuModel = cpus[0].model.trim();
          
          // 清理CPU名称中的多余空格
          cpuModel = cpuModel.replace(/\s+/g, ' ');
          
          // 构建完整的CPU信息
          cpuInfo = `${cpuModel} (${cpus.length} 核心)`;
        }
      } catch (error) {
        // 如果获取失败，保持默认值
        cpuInfo = 'Unknown CPU';
      }
      
      return {
        cpu: cpuInfo,
        totalRAM: this.formatBytes(totalRAM),
        freeRAM: this.formatBytes(freeRAM),
        platform: platform,
        arch: arch
      };
    } catch (error) {
      return {
        cpu: 'Unknown CPU',
        totalRAM: this.formatBytes(os.totalmem()),
        freeRAM: this.formatBytes(os.freemem()),
        platform: os.platform(),
        arch: os.arch()
      };
    }
  }

  async displayResults(ailyResult: CompileResult, arduinoResult: CompileResult, platformioResult?: CompileResult) {
    console.log('\n' + chalk.green('=' .repeat(60)));
    console.log(chalk.green.bold('📊 编译结果对比分析'));
    console.log(chalk.green('=' .repeat(60)));

    // 基本信息
    console.log(`\n${chalk.yellow('📁 项目路径:')} ${this.config.projectPath}`);
    if (platformioResult && this.config.platformioPath) {
      console.log(`${chalk.yellow('🔧 PlatformIO项目:')} ${this.config.platformioPath}`);
    }
    console.log(`${chalk.yellow('🎯 目标板:')} ${this.config.board}`);
    console.log(`${chalk.yellow('⚙️  并行任务数:')} ${this.config.jobs}`);

    // 状态对比
    console.log(`\n${chalk.bold('🔧 编译状态')}`);
    console.log(`aily-builder:  ${ailyResult.success ? chalk.green('✅ 成功') : chalk.red('❌ 失败')}`);
    console.log(`arduino-cli:   ${arduinoResult.success ? chalk.green('✅ 成功') : chalk.red('❌ 失败')}`);
    if (platformioResult) {
      console.log(`platformio:    ${platformioResult.success ? chalk.green('✅ 成功') : chalk.red('❌ 失败')}`);
    }

    const allSuccessful = ailyResult.success && arduinoResult.success && (!platformioResult || platformioResult.success);
    
    if (!allSuccessful) {
      console.log(`\n${chalk.red('⚠️  由于编译失败，无法进行详细对比分析')}`);
      if (!ailyResult.success) {
        console.log(`${chalk.red('aily-builder 错误:')} ${ailyResult.error}`);
      }
      if (!arduinoResult.success) {
        console.log(`${chalk.red('arduino-cli 错误:')} ${arduinoResult.error}`);
      }
      if (platformioResult && !platformioResult.success) {
        console.log(`${chalk.red('platformio 错误:')} ${platformioResult.error}`);
      }
      return;
    }

    // 时间对比
    console.log(`\n${chalk.bold('⏱️  编译时间')}`);
    console.log(`aily-builder:  ${chalk.cyan(ailyResult.duration.toFixed(2))} 秒`);
    console.log(`arduino-cli:   ${chalk.cyan(arduinoResult.duration.toFixed(2))} 秒`);
    if (platformioResult) {
      console.log(`platformio:    ${chalk.cyan(platformioResult.duration.toFixed(2))} 秒`);
    }
    
    const speedupArduino = arduinoResult.duration / ailyResult.duration;
    if (speedupArduino > 1) {
      console.log(`${chalk.green('🚀 相比Arduino-CLI:')} aily-builder快 ${chalk.green.bold(speedupArduino.toFixed(2) + '倍')}`);
    } else {
      console.log(`${chalk.yellow('⚡ 相比Arduino-CLI:')} arduino-cli快 ${chalk.yellow.bold((1/speedupArduino).toFixed(2) + '倍')}`);
    }

    if (platformioResult) {
      const speedupPlatformio = platformioResult.duration / ailyResult.duration;
      if (speedupPlatformio > 1) {
        console.log(`${chalk.green('🚀 相比PlatformIO:')} aily-builder快 ${chalk.green.bold(speedupPlatformio.toFixed(2) + '倍')}`);
      } else {
        console.log(`${chalk.yellow('⚡ 相比PlatformIO:')} platformio快 ${chalk.yellow.bold((1/speedupPlatformio).toFixed(2) + '倍')}`);
      }
    }

    // 内存使用量对比
    console.log(`\n${chalk.bold('💾 内存使用量')}`);
    console.log(`${chalk.cyan('Flash存储器(程序空间):')}`);
    console.log(`  aily-builder:  ${this.formatMemoryUsage(ailyResult.flashUsage)}`);
    console.log(`  arduino-cli:   ${this.formatMemoryUsage(arduinoResult.flashUsage)}`);
    if (platformioResult) {
      console.log(`  platformio:    ${this.formatMemoryUsage(platformioResult.flashUsage)}`);
    }
    
    console.log(`${chalk.cyan('RAM内存(动态内存):')}`);
    console.log(`  aily-builder:  ${this.formatMemoryUsage(ailyResult.ramUsage)}`);
    console.log(`  arduino-cli:   ${this.formatMemoryUsage(arduinoResult.ramUsage)}`);
    if (platformioResult) {
      console.log(`  platformio:    ${this.formatMemoryUsage(platformioResult.ramUsage)}`);
    }

    // 二进制文件大小
    if (ailyResult.binarySize && arduinoResult.binarySize) {
      console.log(`\n${chalk.bold('📦 二进制文件大小')}`);
      console.log(`aily-builder:  ${this.formatBytes(ailyResult.binarySize)}`);
      console.log(`arduino-cli:   ${this.formatBytes(arduinoResult.binarySize)}`);
      if (platformioResult && platformioResult.binarySize) {
        console.log(`platformio:    ${this.formatBytes(platformioResult.binarySize)}`);
      }
      
      const sizeDiff = ailyResult.binarySize - arduinoResult.binarySize;
      if (sizeDiff === 0) {
        console.log(`${chalk.green('📏 相比Arduino-CLI:')} 二进制文件大小相同`);
      } else if (sizeDiff > 0) {
        console.log(`${chalk.yellow('📏 相比Arduino-CLI:')} aily-builder二进制文件大 ${this.formatBytes(sizeDiff)}`);
      } else {
        console.log(`${chalk.green('📏 相比Arduino-CLI:')} aily-builder二进制文件小 ${this.formatBytes(-sizeDiff)}`);
      }

      if (platformioResult && platformioResult.binarySize) {
        const platformioDiff = ailyResult.binarySize - platformioResult.binarySize;
        if (platformioDiff === 0) {
          console.log(`${chalk.green('📏 相比PlatformIO:')} 二进制文件大小相同`);
        } else if (platformioDiff > 0) {
          console.log(`${chalk.yellow('📏 相比PlatformIO:')} aily-builder二进制文件大 ${this.formatBytes(platformioDiff)}`);
        } else {
          console.log(`${chalk.green('📏 相比PlatformIO:')} aily-builder二进制文件小 ${this.formatBytes(-platformioDiff)}`);
        }
      }
    }

    // 显示系统硬件信息
    console.log(`\n${chalk.bold('💻 系统硬件信息')}`);
    try {
      const systemInfo = await this.getSystemInfo();
      console.log(`${chalk.cyan('处理器:')} ${systemInfo.cpu}`);
      console.log(`${chalk.cyan('系统内存:')} ${systemInfo.totalRAM} (可用: ${systemInfo.freeRAM})`);
      console.log(`${chalk.cyan('操作系统:')} ${systemInfo.platform} ${systemInfo.arch}`);
    } catch (error) {
      console.log(`${chalk.yellow('⚠️  无法获取系统硬件信息')}`);
    }

    console.log('\n' + chalk.green('=' .repeat(60)));
  }
}

// 命令行参数解析
function parseArgs(): TestConfig {
  const args = process.argv.slice(2);
  
  const config: TestConfig = {
    projectPath: 'examples/blink_sketch',
    board: 'arduino:avr:uno',
    // board: 'arduino:renesas_uno:unor4wifi',
    jobs: 4,
    verbose: false,
    librariesPath: ['C:\\Users\\LENOVO\\AppData\\Local\\Arduino15\\libraries'],
    platformioPath: 'D:\\platformio\\blink_sketch',
    buildProperties: []
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--sketch':
      case '--project':
      case '-s':
        config.projectPath = args[++i];
        break;
      case '--platformio':
      case '--pio':
      case '-p':
        config.platformioPath = args[++i];
        break;
      case '--board':
      case '-b':
        config.board = args[++i];
        break;
      case '--jobs':
      case '-j':
        config.jobs = parseInt(args[++i]);
        break;
      case '--libraries':
      case '-l':
        if (!config.librariesPath) config.librariesPath = [];
        config.librariesPath.push(args[++i]);
        break;
      case '--build-property':
        if (!config.buildProperties) config.buildProperties = [];
        config.buildProperties.push(args[++i]);
        break;
      case '--verbose':
      case '-v':
        config.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Arduino编译性能测试工具

用法: ts-node compile-test.ts [选项]

选项:
  -s, --sketch <路径>       Arduino项目路径 (默认: examples/blink_sketch)
  -p, --platformio <路径>   PlatformIO项目路径 (默认: D:\\platformio\\blink_sketch)
  -b, --board <fqbn>        开发板FQBN (默认: arduino:avr:uno)
  -j, --jobs <数量>         并行任务数 (默认: 4)
  -l, --libraries <路径>    库文件路径 (可多次使用，添加多个库目录)
  --build-property <属性>   构建属性 (可多次使用)
  -v, --verbose             启用详细输出
  -h, --help                显示此帮助信息

示例:
  ts-node compile-test.ts --sketch examples/blink_sketch
  ts-node compile-test.ts --sketch examples/sweep_sketch --platformio D:\\platformio\\servo_test
  ts-node compile-test.ts --sketch /path/to/my/project --board esp32:esp32:esp32
  ts-node compile-test.ts --board esp32:esp32:esp32 --build-property build.flash_mode=dio --build-property build.flash_freq=80m
  ts-node compile-test.ts --libraries "C:\\Users\\User\\Documents\\Arduino\\libraries" --libraries "C:\\Arduino\\libraries"

注意: PlatformIO使用固定项目路径。您可以手动替换PlatformIO项目中的代码来测试不同的sketch文件，
      然后运行测试。
        `);
        process.exit(0);
        break;
    }
  }

  return config;
}

// 主函数
async function main() {
  try {
    const config = parseArgs();
    
    console.log(chalk.blue.bold('\n🧪 Arduino编译性能测试'));
    console.log(chalk.blue('=' .repeat(50)));
    
    const tester = new ArduinoCompileTest(config);
    
    // 顺序执行测试，避免冲突
    console.log(chalk.yellow('📝 开始顺序编译测试...\n'));
    
    // 先执行 aily-builder
    const ailyResult = await tester.testAilyBuilder();
    
    // 等待一点时间，确保资源释放
    console.log(chalk.gray('⏳ 等待资源清理...'));
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 再执行 arduino-cli
    const arduinoResult = await tester.testArduinoCli();
    
    // 等待资源释放
    console.log(chalk.gray('⏳ 等待资源清理...'));
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 最后执行 PlatformIO (如果路径存在)
    let platformioResult: CompileResult | undefined;
    if (config.platformioPath && fs.existsSync(config.platformioPath)) {
      console.log(chalk.yellow('🔧 找到PlatformIO项目，开始测试...'));
      platformioResult = await tester.testPlatformIO();
    } else {
      console.log(chalk.yellow('⚠️  未找到PlatformIO项目，跳过PlatformIO测试'));
      console.log(chalk.gray(`   期望路径: ${config.platformioPath}`));
    }
    
    // 显示结果
    await tester.displayResults(ailyResult, arduinoResult, platformioResult);
    
  } catch (error) {
    console.error(chalk.red('❌ 测试失败:'), error);
    process.exit(1);
  }
}

// 运行测试
if (require.main === module) {
  main();
}