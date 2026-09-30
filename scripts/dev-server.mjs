import { createServer } from 'node:http';
import { readFile,mkdir } from 'node:fs/promises';
import { resolve,extname,sep,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../server/worker.js';
import { NodeDB } from '../server/node-db.js';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),publicRoot=resolve(root,'public');
const production=process.env.NODE_ENV==='production',trustProxy=process.env.TRUST_PROXY==='1';
const port=Number(process.env.PORT||8787),host=process.env.HOST||(production?'0.0.0.0':'127.0.0.1');
const dbPath=resolve(process.env.DB_PATH||resolve(root,'.data/checkers.sqlite'));
if(dbPath.startsWith(publicRoot+sep))throw new Error('DB_PATH must not be inside public/');
await mkdir(dirname(dbPath),{recursive:true});
const db=new NodeDB(dbPath);db.exec(await readFile(resolve(root,'migrations/001.sql'),'utf8'));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json'};
const tasks=new Set();
const ctx={waitUntil(p){tasks.add(p);p.catch(e=>console.error('Background task failed:',e.name)).finally(()=>tasks.delete(p));}};
const env={...process.env,APP_ENV:production?'production':'local',APP_ORIGIN:process.env.APP_ORIGIN||`http://127.0.0.1:${port}`,DB:db,
  ASSETS:{async fetch(request){let path=decodeURIComponent(new URL(request.url).pathname);if(path==='/'||path==='/play/checkers')path='/index.html';
    const target=resolve(publicRoot,'.'+path);if(!target.startsWith(publicRoot+sep))return new Response('Not found',{status:404});
    try{return new Response(await readFile(target),{headers:{'content-type':types[extname(target)]||'application/octet-stream','cache-control':'no-cache'}});}catch{return new Response('Not found',{status:404});}}}};
const server=createServer(async(req,res)=>{
  try{
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>1048576){res.writeHead(413);res.end('Too large');return;}chunks.push(chunk);}
    const headers=new Headers(req.headers);headers.delete('cf-connecting-ip');
    const peer=(trustProxy?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'')||req.socket.remoteAddress;if(peer)headers.set('cf-connecting-ip',peer);
    const request=new Request(`${env.APP_ORIGIN}${req.url}`,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
    const response=await worker.fetch(request,env,ctx);res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){console.error(error.name);res.writeHead(500);res.end('Internal error');}
});
server.listen(port,host,()=>console.log(`Checkers: ${env.APP_ORIGIN}\nJEV: ${env.TYPESAFE_API_KEY?'configured':'not configured; local practice is available'}\nDatabase: SQLite file (ephemeral on Node hosting). Press Ctrl+C to stop.`));
const timer=setInterval(()=>worker.scheduled({},env,ctx),60000);timer.unref();
async function stop(){clearInterval(timer);server.close();await Promise.allSettled([...tasks]);db.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
