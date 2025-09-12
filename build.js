const { compile } = require('nexe')

compile(
    {
        input: './dist/main.js',
        output: './dist/aily-builder.exe',
        target: 'windows-x64-22.19.0',
        name: 'aily-builder',
        // ico: undefined, // 可以删除或设置为实际图标路径
        build: true,
        enableNodeCli: false,
        // verbose: true, // 这个属性应该是 loglevel
        loglevel: 'verbose',
        // silent: false, // 删除，与 loglevel 冲突
        cwd: process.cwd(),
        flags: [],
        configure: [],
        make: []
    }
).then(() => {
    console.log('success')
})