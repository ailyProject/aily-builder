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
    return 'esptool'
}