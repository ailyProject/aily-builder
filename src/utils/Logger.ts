export class Logger {
  private isVerbose: boolean = false;
  
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

  info(message: string): void {
    console.log(`${this.colors.blue}[INFO]${this.colors.reset} ${message}`);
  }

  success(message: string): void {
    console.log(`${this.colors.green}[SUCCESS]${this.colors.reset} ${message}`);
  }

  error(message: string): void {
    console.error(`${this.colors.red}[ERROR]${this.colors.reset} ${message}`);
  }

  warn(message: string): void {
    console.warn(`${this.colors.yellow}[WARN]${this.colors.reset} ${message}`);
  }

  debug(message: string): void {
    if (this.isVerbose) {
      console.log(`${this.colors.magenta}[DEBUG]${this.colors.reset} ${message}`);
    }
  }

  verbose(message: string): void {
    if (this.isVerbose) {
      console.log(`${this.colors.gray}[VERBOSE]${this.colors.reset} ${message}`);
    }
  }
}
