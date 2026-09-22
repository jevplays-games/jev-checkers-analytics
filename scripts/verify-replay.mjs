#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { verifyReplay } from '../public/lib/audit.js';
const file=process.argv[2];
if(!file){console.error('Usage: npm run verify -- path/to/replay.json');process.exit(2);}
try{const result=await verifyReplay(JSON.parse(await readFile(file,'utf8')));const {state,...report}=result;console.log(JSON.stringify(report,null,2));}
catch(error){console.error(JSON.stringify({valid:false,error:error.message}));process.exit(1);}
