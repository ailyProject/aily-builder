module.exports = {
  input: './dist/main.js',
  output: './dist/aily.exe',
  target: 'windows-x64-18.20.4',
  name: 'aily',
  ico: undefined,
  build: false,
  temp: './nexe-cache',
  enableNodeCli: false,
  verbose: true,
  silent: false,
  cwd: process.cwd(),
  flags: [],
  configure: [],
  make: []
}
