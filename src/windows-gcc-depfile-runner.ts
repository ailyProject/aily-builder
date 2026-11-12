import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

function decodeAnsiDepfile(bytes: Buffer, encoding: string): string {
  const decoder = new TextDecoder(encoding, { fatal: true });
  const text = decoder.decode(bytes);
  if (!/^(?:gbk|gb18030|shift_jis|big5)$/.test(encoding) || !/\\{2,}[ \t]/.test(text)) return text;

  // Spaces and tabs cannot occur inside these multibyte encodings, so their
  // raw and decoded occurrences correspond. GCC doubles each preceding 0x5c
  // before escaping a space. If one disappeared during decoding, it was a
  // trail byte and its extra escape needs to be removed as well.
  const raw = bytes.toString('latin1');
  const whitespace = /[ \t]/g;
  return text.replace(/(\\*)[ \t]/g, (match, slashes: string) => {
    const beforeSlashes = whitespace.exec(raw).index - slashes.length;
    if (slashes.length >= 2 && slashes.length % 2 === 0
      && raw[beforeSlashes - 1] === '\\' && raw[beforeSlashes - 2] !== '\\') {
      return match.slice(1);
    }
    return match;
  });
}

export function encodeDepfileAsUtf8(bytes: Buffer, encoding: string): Buffer {
  if (!bytes.some(byte => byte >= 0x80)) return bytes;

  // The compiler probe established the encoding. ACP takes precedence when
  // a byte sequence is valid in both encodings.
  try {
    return Buffer.from(decodeAnsiDepfile(bytes, encoding));
  } catch {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return bytes;
  }
}

function run(encoding: string, depfile: string, executable: string, args: string[]): number {
  // Never read a depfile left by an interrupted earlier command.
  fs.rmSync(depfile, { force: true });
  const compiler = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true });
  if (compiler.error) throw compiler.error;
  if (compiler.status !== 0) return compiler.status ?? 1;

  // A plain assembly recipe can succeed without emitting dependencies.
  if (!fs.existsSync(depfile)) return 0;
  const original = fs.readFileSync(depfile);
  const utf8 = encodeDepfileAsUtf8(original, encoding);
  if (original.equals(utf8)) return 0;

  const temporary = depfile + '.utf8-' + process.pid;
  try {
    fs.writeFileSync(temporary, utf8, { flag: 'wx' });
    fs.renameSync(temporary, depfile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return 0;
}

if (require.main === module) {
  const [encoding, depfile, executable, ...args] = process.argv.slice(2);
  try {
    process.exitCode = run(encoding, depfile, executable, args);
  } catch (error) {
    console.error('Could not process the compiler dependency file:', error.message);
    process.exitCode = 1;
  }
}
