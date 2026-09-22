#!/usr/bin/env node
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyReplay } from '../public/lib/audit.js';
import { analyzeReplay,toCSV,flatEvents } from '../public/lib/analytics.js';
const [file,out='analytics-export']=process.argv.slice(2);if(!file){console.error('Usage: node scripts/analyze-replay.mjs replay.json output-directory');process.exit(2);}
const replay=JSON.parse(await readFile(file,'utf8'));await verifyReplay(replay);const a=analyzeReplay(replay);await mkdir(out,{recursive:true});
for(const [name,content]of Object.entries({'analytics.json':JSON.stringify(a,null,2),'moves.csv':toCSV(a.moves),'candidates.csv':toCSV(a.candidates),'positions.csv':toCSV(a.points),'events.csv':toCSV(flatEvents(replay))}))await writeFile(resolve(out,name),content);
console.log(`Wrote all recorded-turn metrics to ${resolve(out)}`);
