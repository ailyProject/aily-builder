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
    // 使用空格切割命令字符串，取第一个元素作为路径
    const parts = commandString.split(' ');
    const toolPath = parts[0];
    
    // 提取路径中的文件名
    // 处理 Windows 和 Unix 风格的路径分隔符
    const pathSeparatorRegex = /[\\\/]/;
    const pathParts = toolPath.split(pathSeparatorRegex);
    const fileName = pathParts[pathParts.length - 1];
    
    // 移除可能的引号
    return fileName.replace(/^["']|["']$/g, '');
}