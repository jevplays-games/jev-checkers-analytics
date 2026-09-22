/** Minimal uncompressed ZIP writer for UTF-8 analytics exports. No library or network required. */
const encoder=new TextEncoder();
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes){let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function record(length){const bytes=new Uint8Array(length);return {bytes,view:new DataView(bytes.buffer)};}
export function makeZip(files){
  const local=[],central=[];let offset=0,centralSize=0;
  for(const [name,value] of Object.entries(files)){
    const path=encoder.encode(name),data=typeof value==='string'?encoder.encode(value):value,checksum=crc(data),l=record(30+path.length);
    l.view.setUint32(0,0x04034b50,true);l.view.setUint16(4,20,true);l.view.setUint16(6,0x0800,true);
    l.view.setUint16(12,33,true);l.view.setUint32(14,checksum,true);l.view.setUint32(18,data.length,true);l.view.setUint32(22,data.length,true);l.view.setUint16(26,path.length,true);l.bytes.set(path,30);
    local.push(l.bytes,data);
    const c=record(46+path.length);c.view.setUint32(0,0x02014b50,true);c.view.setUint16(4,20,true);c.view.setUint16(6,20,true);c.view.setUint16(8,0x0800,true);
    c.view.setUint16(14,33,true);c.view.setUint32(16,checksum,true);c.view.setUint32(20,data.length,true);c.view.setUint32(24,data.length,true);c.view.setUint16(28,path.length,true);c.view.setUint32(42,offset,true);c.bytes.set(path,46);
    central.push(c.bytes);centralSize+=c.bytes.length;offset+=l.bytes.length+data.length;
  }
  const end=record(22);end.view.setUint32(0,0x06054b50,true);end.view.setUint16(8,central.length,true);end.view.setUint16(10,central.length,true);end.view.setUint32(12,centralSize,true);end.view.setUint32(16,offset,true);
  return new Blob([...local,...central,end.bytes],{type:'application/zip'});
}
