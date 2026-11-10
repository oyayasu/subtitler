import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const esbuild=process.env.ESBUILD_MODULE?await import(pathToFileURL(process.env.ESBUILD_MODULE)):await import('esbuild');
const result=await esbuild.build({absWorkingDir:root,entryPoints:['src/app.js'],outfile:'src/app.bundle.js',bundle:true,format:'iife',platform:'browser',target:['safari13.1'],charset:'utf8',legalComments:'inline',metafile:true});
const files=Object.keys(result.metafile.inputs).sort(),sources={};for(const file of files)sources[file]=crypto.createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
const bundle=await fs.readFile(path.join(root,'src/app.bundle.js'));
await fs.writeFile(path.join(root,'src/frontend-manifest.json'),JSON.stringify({format:'whisperdesk-frontend-build-v1',target:'safari13.1',sources,bundleSha256:crypto.createHash('sha256').update(bundle).digest('hex')},null,2)+'\n');
console.log('Built self-contained browser bundle for Safari 13.1+, '+bundle.length+' bytes.');
