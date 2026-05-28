export function extractCommandExecutable(str: string): string {
  const parsed = splitCommand(str);
  return parsed.executable;
}

export function removeCompilerPath(str: string): string {
  const parsed = splitCommand(str);
  return parsed.args;
}

function splitCommand(str: string): { executable: string; args: string } {
  if (!str || typeof str !== 'string') {
    return { executable: '', args: '' };
  }

  const command = str.trim();
  if (!command) {
    return { executable: '', args: '' };
  }

  const quote = command[0];
  if (quote === '"' || quote === "'") {
    const endQuoteIndex = command.indexOf(quote, 1);
    if (endQuoteIndex === -1) {
      return { executable: command.substring(1), args: '' };
    }

    return {
      executable: command.substring(1, endQuoteIndex),
      args: command.substring(endQuoteIndex + 1).trimStart()
    };
  }

  const firstSpaceIndex = command.search(/\s/);
  if (firstSpaceIndex === -1) {
    return { executable: command, args: '' };
  }

  return {
    executable: command.substring(0, firstSpaceIndex),
    args: command.substring(firstSpaceIndex + 1).trimStart()
  };
}