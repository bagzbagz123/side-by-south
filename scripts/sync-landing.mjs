import {readFile,writeFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
await writeFile(new URL('../lib/landing-html.ts',import.meta.url),'// Generated from public/index.html by scripts/sync-landing.mjs.\nexport default '+JSON.stringify(html)+';\n');
