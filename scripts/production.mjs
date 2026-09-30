// Production when NODE_ENV=production OR APP_ORIGIN is https on a non-loopback host (GoDaddy does not set NODE_ENV).
export function isProduction(env){
  if(env.NODE_ENV==='production')return true;
  try{const u=new URL(env.APP_ORIGIN||'');return u.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname);}catch{return false;}
}
