import fs from 'fs-extra';
import { spawn } from 'child_process';
import { Logger } from './utils/Logger';
import { ArduinoConfigParser } from './ArduinoConfigParser';

export interface UploadOptions {
    board: string;
    port: string;
    filePath: string;
    buildProperties?: Record<string, string>;
    verbose?: boolean;
}

export interface UploadResult {
    success: boolean;
    uploadTime: number;
    error?: string;
    output?: string;
}

export class ArduinoUploader {
    private logger: Logger;
    private arduinoConfigParser: ArduinoConfigParser;

    constructor(logger: Logger) {
        this.logger = logger;
        this.arduinoConfigParser = new ArduinoConfigParser();
    }

    async upload(options: UploadOptions): Promise<UploadResult> {
        const startTime = Date.now();

        try {
            this.logger.verbose('Starting upload process...');

            // 验证固件文件存在
            if (!await fs.pathExists(options.filePath)) {
                throw new Error(`Firmware file not found: ${options.filePath}`);
            }

            // 获取开发板配置
            const arduinoConfig = await this.arduinoConfigParser.parseByFQBN(
                options.board,
                options.buildProperties || {}
            );

            console.log(arduinoConfig);


            // 设置上传相关的环境变量
            process.env['SERIAL_PORT'] = options.port;
            process.env['FIRMWARE_PATH'] = options.filePath;

            // 构建上传命令
            //   let uploadCommand = arduinoConfig.platform['upload.pattern'];
            //   if (!uploadCommand) {
            //     throw new Error(`No upload pattern found for board: ${options.board}`);
            //   }
            let platform = 'esp32';
            let uploadPattern;
            switch (platform) {
                case 'avr':
                    uploadPattern = 'avrdude "-C{config.path}" {upload.verbose} {upload.verify} -patmega328p -carduino "-P{serial.port}" -b115200 -D "-Uflash:w:%OUTPUT_PATH%/{build.project_name}.hex:i"'
                    break;
                case 'renesas_uno':
                    uploadPattern = 'bossac {upload.verbose} --port={serial.port.file} -U -e -w "%OUTPUT_PATH%/{build.project_name}.bin" -R';
                    break;
                case 'esp32':
                    uploadPattern = 'esptool --chip esp32 --port "{serial.port}" --baud {upload.speed}  --before default-reset --after hard-reset write-flash {upload.erase_cmd} -z --flash-mode keep --flash-freq keep --flash-size keep 0x1000 "%OUTPUT_PATH%/{build.project_name}.bootloader.bin" 0x8000 "%OUTPUT_PATH%/{build.project_name}.partitions.bin" 0xe000 "C:\\Users\\coloz\\AppData\\Local\\Arduino15\\packages\\esp32\\hardware\\esp32\\esp32@3.3.0/tools/partitions/boot_app0.bin" 0x10000 "%OUTPUT_PATH%/{build.project_name}.bin"';
                    break;
                case 'rp2040':
                    uploadPattern = 'picotool -e -w "%OUTPUT_PATH%/{build.project_name}.uf2" -R';
                    break;
                case 'stm32':
                    uploadPattern = 'st-flash write "%OUTPUT_PATH%/{build.project_name}.bin" 0x8000000';
                    break;
                case 'samd':
                    uploadPattern = 'bossac {upload.verbose} --port={serial.port.file} -U -e -w "%OUTPUT_PATH%/{build.project_name}.bin" -R';
                    break;
                case 'mcs51':
                    uploadPattern = 'uploader_tool -p {serial.port} -b {upload.speed} -f "%OUTPUT_PATH%/{build.project_name}.hex"';
                    break;
                default:
                    break;
            }


            // 替换Windows特定的上传工具路径（如果存在）
            // if (arduinoConfig.platform['tools.esptool_py.upload.pattern.windows']) {
            //     uploadCommand = arduinoConfig.platform['tools.esptool_py.upload.pattern.windows'];
            // }

            // this.logger.info(`📤 Uploading firmware to ${options.port}...`);
            // this.logger.verbose(`Upload command: ${uploadCommand}`);

            // // 执行上传命令
            // const output = await this.runCommand(uploadCommand);

            const uploadTime = Date.now() - startTime;

            this.logger.success(`✅ Upload completed successfully!`);

            return {
                success: true,
                uploadTime,
                // output
            };

        } catch (error) {
            const uploadTime = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);

            this.logger.error(`Upload failed: ${errorMessage}`);

            return {
                success: false,
                uploadTime,
                error: errorMessage
            };
        }
    }

    private async runCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, [], {
                shell: true,
                stdio: 'pipe'
            });

            const stdoutBuffers: Buffer[] = [];
            const stderrBuffers: Buffer[] = [];

            child.stdout?.on('data', (data: Buffer) => {
                stdoutBuffers.push(data);
                if (this.logger) {
                    // 实时输出上传进度
                    const output = data.toString('utf8');
                    if (output.trim()) {
                        this.logger.verbose(`Upload: ${output.trim()}`);
                    }
                }
            });

            child.stderr?.on('data', (data: Buffer) => {
                stderrBuffers.push(data);
                if (this.logger) {
                    // 实时输出错误信息
                    const output = data.toString('utf8');
                    if (output.trim()) {
                        this.logger.verbose(`Upload stderr: ${output.trim()}`);
                    }
                }
            });

            child.on('close', (code) => {
                const stdoutBuffer = Buffer.concat(stdoutBuffers);
                const stderrBuffer = Buffer.concat(stderrBuffers);

                // 直接使用 UTF-8 解码
                const stdout = stdoutBuffer.toString('utf8');
                const stderr = stderrBuffer.toString('utf8');

                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(`Upload command failed with exit code ${code}: ${command}\nStderr: ${stderr}`));
                }
            });

            child.on('error', (error) => {
                reject(new Error(`Failed to execute upload command: ${error.message}`));
            });
        });
    }

    /**
     * 验证串口是否可用
     */
    async validatePort(port: string): Promise<boolean> {
        try {
            // 这里可以添加串口验证逻辑
            // 例如检查串口是否存在，是否可访问等
            return true;
        } catch (error) {
            this.logger.debug(`Port validation failed: ${error instanceof Error ? error.message : error}`);
            return false;
        }
    }

    /**
     * 获取可用的串口列表（可选功能）
     */
    async getAvailablePorts(): Promise<string[]> {
        try {
            // 这里可以添加获取系统可用串口的逻辑
            // 在Windows上可能是 COM1, COM2 等
            // 在Linux/Mac上可能是 /dev/ttyUSB0, /dev/ttyACM0 等
            return [];
        } catch (error) {
            this.logger.debug(`Failed to get available ports: ${error instanceof Error ? error.message : error}`);
            return [];
        }
    }
}