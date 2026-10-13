const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os');
const {collectArduinoSketchTabs,readArduinoSketch,collectArduinoSketchSources}=require('../dist/src/ArduinoSketchSources');
const {parseCompilerDependencies}=require('../dist/src/ArduinoSketchDependencies');
test('multi-tab sketches merge primary first, preserve diagnostics and compile only Arduino source locations',async t=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'arduino-sources-'));t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'Tabs');fs.mkdirSync(root);
 for(const [name,content] of Object.entries({'Tabs.ino':'void setup(){helper();}\nvoid loop(){}','A.ino':'void helper(){}','Z.ino':'int z;','extra.cpp':'int extra;','src/deep/core.cpp':'int core;','src/deep/c_api.c':'int c_api;','data/ignore.cpp':'#error wrong','examples/ignore.cpp':'#error wrong','.build/ignore.cpp':'#error wrong'})){
  fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),content);
 }
 const entry=path.join(root,'A.ino');
 assert.deepEqual((await collectArduinoSketchTabs(entry)).map(file=>path.basename(file)),['Tabs.ino','A.ino','Z.ino']);
 const code=await readArduinoSketch(entry);assert.ok(code.indexOf('void setup')<code.indexOf('void helper'));assert.match(code,/#line 1 .*A\.ino/);
 assert.deepEqual((await collectArduinoSketchSources(entry)).map(file=>path.relative(root,file)),['extra.cpp','src/deep/c_api.c','src/deep/core.cpp']);
 assert.deepEqual(await collectArduinoSketchSources(path.join(root,'extra.cpp')),[]);
});
test('GCC dependencies preserve escaped spaces, line continuation and Windows drive paths',()=>{
 assert.deepEqual(parseCompilerDependencies('aily-deps: /tmp/a\\ b.cpp \\\n C:/src/header.h missing.h\n'),['/tmp/a b.cpp','C:/src/header.h','missing.h']);
});
