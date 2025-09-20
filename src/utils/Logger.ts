import fs from 'fs';
import path from 'path';

export class Logger {
  private isVerbose: boolean = false;
  private logFilePath: string | null = null;
  private logToFile: boolean = false;
  
  // ANSI颜色代码
  private colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
  };

  setVerbose(verbose: boolean): void {
    this.isVerbose = verbose;
  }

  setLogFile(logFilePath: string): void {
    this.logFilePath = logFilePath;
    this.logToFile = true;
    
    // 确保日志文件目录存在
    const logDir = path.dirname(logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // 创建或清空日志文件
    try {
      fs.writeFileSync(logFilePath, `aily-builder log\nDate: ${new Date().toISOString()}\n----------------------------------------------------------------------------\n`);
    } catch (error) {
      console.error(`Failed to initialize log file: ${error}`);
      this.logToFile = false;
    }
  }

  disableLogFile(): void {
    this.logToFile = false;
    this.logFilePath = null;
  }

  private writeToFile(message: string): void {
    if (this.logToFile && this.logFilePath) {
      try {
        const logLine = `${message}\n`;
        fs.appendFileSync(this.logFilePath, logLine);
      } catch (error) {
        // 如果写入失败，输出到控制台并禁用文件日志
        console.error(`Failed to write to log file: ${error}`);
        this.logToFile = false;
      }
    }
  }

  private removeAnsiColors(text: string): string {
    // 移除ANSI颜色代码，用于文件输出
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  info(message: string): void {
    const coloredMessage = `${this.colors.blue}[INFO]${this.colors.reset} ${message}`;
    console.log(coloredMessage);
    this.writeToFile(`[INFO] ${message}`);
  }

  success(message: string): void {
    const coloredMessage = `${this.colors.green}[SUCCESS]${this.colors.reset} ${message}`;
    console.log(coloredMessage);
    this.writeToFile(`[SUCCESS] ${message}`);
  }

  error(message: string): void {
    const coloredMessage = `${this.colors.red}[ERROR]${this.colors.reset} ${message}`;
    console.error(coloredMessage);
    this.writeToFile(`[ERROR] ${message}`);
  }

  warn(message: string): void {
    const coloredMessage = `${this.colors.yellow}[WARN]${this.colors.reset} ${message}`;
    console.warn(coloredMessage);
    this.writeToFile(`[WARN] ${message}`);
  }

  debug(message: string): void {
    if (this.isVerbose) {
      const coloredMessage = `${this.colors.magenta}[DEBUG]${this.colors.reset} ${message}`;
      console.log(coloredMessage);
      this.writeToFile(`[DEBUG] ${message}`);
    }
  }

  verbose(message: string): void {
    if (this.isVerbose) {
      const coloredMessage = `${this.colors.gray}[VERBOSE]${this.colors.reset} ${message}`;
      console.log(coloredMessage);
      this.writeToFile(`[VERBOSE] ${message}`);
    }
  }
}
