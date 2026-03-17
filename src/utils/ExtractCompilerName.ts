// 提取编译程序名称
export function extractCompilerName(commandString) {
    // 正则表达式说明：
    // \"([^\"]*\\(?:g\+\+|gcc)(?:\.exe)?)\"  匹配双引号内以g++或gcc结尾的路径
    // ([^\"]*\\  匹配路径部分（非双引号字符 + 反斜杠或正斜杠）
    // (?:g\+\+|gcc)  匹配 g++ 或 gcc
    // (?:\.exe)?  可选的 .exe 后缀
    const regex = /\"([^\"]*[\\\/])([^\\\/\"]*(?:g\+\+|gcc)(?:\.exe)?)\"/;

    const match = commandString.match(regex);

    if (match) {
        return match[2]; // 返回编译器名称部分
    }

    return null;
}

export function extractToolName(commandString) {
    // 提取第一个 token（编译器/工具路径），支持带引号的路径（路径内可含空格）
    let toolPath: string;
    if (commandString.startsWith('"')) {
        const closeQuote = commandString.indexOf('"', 1);
        toolPath = closeQuote !== -1
            ? commandString.substring(1, closeQuote)
            : commandString.substring(1);
    } else {
        toolPath = commandString.split(' ')[0];
    }

    // 提取路径中的文件名（处理 Windows 和 Unix 风格的路径分隔符）
    const pathParts = toolPath.split(/[\\\/]/);
    const fileName = pathParts[pathParts.length - 1];

    // 移除可能的引号
    return fileName.replace(/^["']|["']$/g, '');
}