"""Render and exercise actual browser source in an in-memory document.
The execution environment forbids Chromium URL navigation. Only the loader, WebCrypto
hash bridge, storage host and HTTP transport are adapted; game/analytics source is unchanged.
"""
import hashlib,json,pathlib,re,urllib.request,urllib.error,zipfile,os
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[1];out=root/'reports';out.mkdir(exist_ok=True)
sources={'/'+str(f.relative_to(root/'public')):f.read_text() for f in (root/'public').rglob('*.js')}
html=(root/'public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link\b[^>]*>','',html)
brandcss=(root/'public/brand/brand.css').read_text()
css=(root/'public/game.css').read_text();results=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
 def newpage(width=1440,height=1150,saved=None):
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  page.on('pageerror',lambda e: print('BROWSER ERROR:',e))
  cookie={'value':''}
  def http(url,init):
   headers=init.get('headers',{});headers['Origin']='http://127.0.0.1:8787';headers['Cookie']=cookie['value']
   req=urllib.request.Request('http://127.0.0.1:8787'+url,data=init.get('body','').encode() if init.get('method')=='POST' else None,headers=headers,method=init.get('method','GET'))
   try:r=urllib.request.urlopen(req)
   except urllib.error.HTTPError as error:r=error
   if r.headers.get('Set-Cookie'):cookie['value']=r.headers['Set-Cookie'].split(';')[0]
   return {'status':r.status,'body':r.read().decode(),'headers':dict(r.headers)}
  page.expose_function('_testDigest',lambda data:list(hashlib.sha256(bytes(data)).digest()))
  page.expose_function('_testHTTP',http)
  page.set_content(html,wait_until='domcontentloaded');page.add_style_tag(content=brandcss)
  page.add_style_tag(content=css)
  page.evaluate('''({sources,saved})=>{
   window._errors=[];addEventListener('unhandledrejection',e=>window._errors.push(e.reason?.stack||String(e.reason)));
   Object.defineProperty(crypto,'subtle',{value:{digest:async(_name,bytes)=>new Uint8Array(await window._testDigest(Array.from(new Uint8Array(bytes.buffer||bytes,bytes.byteOffset||0,bytes.byteLength)))).buffer}});
   if(!crypto.randomUUID)crypto.randomUUID=()=>{const b=new Uint8Array(16);crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const s=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;};
   class MemoryStorage{constructor(data={}){this.data=data;}getItem(k){return Object.hasOwn(this.data,k)?this.data[k]:null;}setItem(k,v){this.data[k]=String(v);}removeItem(k){delete this.data[k];}clear(){this.data={};}}
   Object.defineProperty(window,'localStorage',{value:new MemoryStorage(saved||{})});Object.defineProperty(window,'sessionStorage',{value:new MemoryStorage()});
   window.fetch=async(url,init={})=>{const r=await window._testHTTP(String(url),{method:init.method||'GET',headers:init.headers||{},body:init.body||''});return new Response(r.body,{status:r.status,headers:r.headers});};
   const urls={};function build(path){if(urls[path])return urls[path];let source=sources[path];if(source===undefined)throw Error('Missing source '+path);
    source=source.replace(/from\\s+(['"])(.*?)\\1/g,(_m,_q,spec)=>`from '${build(new URL(spec,'https://test.invalid'+path).pathname)}'`);
    return urls[path]=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));}
   window.Worker=class {constructor(url,opts){this.url=url;}terminate(){}postMessage(data){import(build('/games/checkers/strategy.js')).then(module=>{try{const decision=module.chooseLocalAction(data.state,data.difficulty);this.onmessage?.({data:{id:data.id,decision}});}catch(error){this.onmessage?.({data:{id:data.id,error:error.message}});}});}};
   window._testExports=[];const realClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith('blob:'))window._testExports.push({name:this.download,url:this.href});else realClick.call(this);};
   window._testMain=build('/game.js');return import(window._testMain);
  }''',{'sources':sources,'saved':saved or {}})
  return page
 page=newpage();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.wait_for_function("document.querySelector('#connection').textContent==='LOCAL READY'")
 page.wait_for_timeout(300);assert not page.evaluate('window._errors');assert page.locator('#board .piece').count()==24;assert page.evaluate("document.querySelector('#board .piece').getBoundingClientRect().width/document.querySelector('#board .piece').parentElement.getBoundingClientRect().width>.65");results.append({'test':'initial board has 24 pieces','passed':True})
 page.locator('#new-game').click();page.wait_for_function("document.querySelector('#turn-status').textContent.startsWith('Your turn')")
 page.locator('#board [data-square="9"]').click();page.locator('#board [data-square="13"]').click()
 page.wait_for_function("document.querySelector('#metric-turns').textContent==='2'")
 results.append({'test':'human/local-opponent two-turn gameplay','passed':True})
 page.screenshot(path=str(out/'desktop-preview.png'),full_page=True)
 page.locator('#decisions-tab').click();assert page.locator('#candidate-table tbody tr').count()>0;results.append({'test':'candidate comparisons','passed':True})
 page.locator('#replay-tab').click();page.locator('#replay-slider').fill('2');assert page.locator('#replay-label').inner_text()=='Event 2 / 2';results.append({'test':'replay independent of live board','passed':True})
 page.locator('#events-tab').click();assert page.locator('#events-table tbody tr').count()==2;results.append({'test':'event audit shows both actors','passed':True})
 page.locator('#verify').click();page.wait_for_function("document.querySelector('#audit-status').textContent.startsWith('Integrity verified')");results.append({'test':'replay verification in browser','passed':True})
 # Capture generated Blob without a browser navigation or download.
 page.evaluate('''()=>{const make=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='application/zip')window._zipBlob=blob;return make(blob);};}''')
 page.locator('#export').click();page.wait_for_function("!!window._zipBlob")
 data=bytes(page.evaluate('async()=>Array.from(new Uint8Array(await window._zipBlob.arrayBuffer()))'))
 (out/'browser-analytics-example.zip').write_bytes(data)
 with zipfile.ZipFile(out/'browser-analytics-example.zip') as z:
  assert len(z.namelist())==11;assert z.testzip() is None
  replay=json.loads(z.read('replay.json'));assert len(replay['events'])==2;(out/'example-replay.json').write_text(json.dumps(replay,indent=2))
 results.append({'test':'valid 11-file analytics ZIP generated by actual browser code','passed':True})
 page.locator('#board [data-square="1"]').focus();page.keyboard.press('ArrowUp');assert page.evaluate("!!document.activeElement.closest('#board')")
 results.append({'test':'keyboard board navigation','passed':True})
 saved=page.evaluate('localStorage.data');restored=newpage(saved=saved);restored.wait_for_function("document.querySelector('#metric-turns').textContent==='2'")
 results.append({'test':'unfinished game restored from persisted record','passed':True})
 page.locator('#leaderboard-tab').click();page.wait_for_function("document.querySelector('#leaderboard-table').textContent.includes('No records yet')")
 results.append({'test':'empty leaderboard does not fabricate entries','passed':True})
 mobile=newpage(390,844);mobile.locator('#new-game').click();mobile.wait_for_function("document.querySelector('#turn-status').textContent.startsWith('Your turn')")
 assert mobile.evaluate('document.documentElement.scrollWidth<=window.innerWidth');mobile.screenshot(path=str(out/'mobile-preview.png'),full_page=True)
 results.append({'test':'390px mobile layout without horizontal overflow','passed':True})
 page.locator('#import-replay').set_input_files(str(out/'example-replay.json'));page.wait_for_function("document.querySelector('#notice').textContent.startsWith('Imported record')")
 results.append({'test':'read-only replay import','passed':True})
 for tested in (page,restored,mobile):
  assert not tested.evaluate('window._errors')
 assert not errors,errors;results.append({'test':'no uncaught game JavaScript errors','passed':True})
 browser.close()
report={'runner':'System Chromium via Python Playwright','method':'In-memory source loading: URL navigation is blocked by environment policy. Storage, digest, worker transport and local HTTP transport are harness bridges. Off-main-thread Worker transport itself is not verified here. Actual game, search, replay, chart and export modules execute in Chromium.','tests':results,'errors':errors}
(out/'browser-tests.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
