import chalk from 'chalk';

export class Logger {
  private isVerbose: boolean = false;

  setVerbose(verbose: boolean): void {
    this.isVerbose = verbose;
  }

  info(message: string): void {
    console.log(message);
  }

  success(message: string): void {
    console.log(message);
  }

  error(message: string): void {
    console.error(message);
  }

  warn(message: string): void {
    console.warn(chalk.yellow(message));
  }

  debug(message: string): void {
    if (this.isVerbose) {
      console.log(chalk.gray(`[DEBUG] ${message}`));
    }
  }

  verbose(message: string): void {
    if (this.isVerbose) {
      console.log(chalk.cyan(`[VERBOSE] ${message}`));
    }
  }
}
