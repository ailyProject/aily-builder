const { mkdir, copyFile, chmod, cp } = require('node:fs/promises');
const path = require('node:path');

/** Both TypeScript and bundled distributions use the same provided tool assets. */
async function copyNinja(destination = path.join(__dirname, 'dist', 'ninja'), source = path.join(__dirname, 'ninja')) {
  await mkdir(destination, { recursive: true });
  await cp(path.join(__dirname, 'resources'), path.join(path.dirname(destination), 'resources'), { recursive: true });

  for (const name of ['ninja.exe', 'ninja']) {
    const target = path.join(destination, name);

    await copyFile(path.join(source, name), target);

    if (name === 'ninja') await chmod(target, 0o755);
  }
}

module.exports = { copyNinja };

if (require.main === module) {
  copyNinja()
    .then(() => chmod(path.join(__dirname, 'dist', 'main.js'), 0o755))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
