#!/usr/bin/env node
/** Explicit deployment-time command registration. No bot process or bot token required. */
const {DISCORD_APPLICATION_ID:id,DISCORD_CLIENT_SECRET:secret}=process.env;
if(!id||!secret)throw Error('Set DISCORD_APPLICATION_ID and DISCORD_CLIENT_SECRET first.');
const credentials=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
 body:new URLSearchParams({client_id:id,client_secret:secret,grant_type:'client_credentials',scope:'applications.commands.update'}),signal:AbortSignal.timeout(10000)});
if(!credentials.ok)throw Error(`Command-authorization failed (${credentials.status}).`);
const {access_token}=await credentials.json();
try{
 // POST upserts this command by name without bulk-overwriting other application commands.
 const response=await fetch(`https://discord.com/api/v10/applications/${id}/commands`,{method:'POST',headers:{authorization:`Bearer ${access_token}`,'content-type':'application/json'},
  body:JSON.stringify({name:'play',description:'Launch a JEV Arcade game',type:1,integration_types:[0],contexts:[0],options:[{type:1,name:'checkers',description:'Play checkers against JEV'}]}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error(`Command registration failed (${response.status}).`);
 const command=await response.json();console.log(`Registered /play checkers (command ${command.id}).`);
}finally{
 try{await fetch('https://discord.com/api/oauth2/token/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:id,client_secret:secret,token:access_token}),signal:AbortSignal.timeout(5000)});}catch{/* Token is not retained. */}
}
