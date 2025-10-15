import { promises as fs } from 'fs';

async function debugFileContent() {
    const filePath = 'c:\\Users\\coloz\\Documents\\aily-project\\project_oct15a\\.temp\\libraries\\Blinker\\Widgets\\BlinkerTimer.h';
    
    console.log('=== 原始文件内容 ===');
    const raw = await fs.readFile(filePath, 'utf8');
    console.log('长度:', raw.length);
    console.log('前200字符:');
    console.log(raw.substring(0, 200));
    console.log('');
    
    console.log('=== 预处理后 ===');
    const preprocessed = raw.replace(/\\\s*[\r\n]+\s*/g, ' ');
    console.log('长度:', preprocessed.length);
    console.log('前200字符:');
    console.log(preprocessed.substring(0, 200));
}

debugFileContent().catch(console.error);
