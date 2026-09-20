import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CapabilityError } from './stable/errors.js';
// Conservative public IPv4 only: avoids IPv4-mapped IPv6 and unusual literal bypasses.
export function publicIPv4(address) {
  if(isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===0||b===168))||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0));
}
export async function validateRecipeUrl(value,lookupFn=lookup) {
  let url;try{url=new URL(value);}catch{throw new CapabilityError('INVALID_INPUT','Invalid recipe URL.');}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.hostname.endsWith('.local')||url.hostname==='localhost')throw new CapabilityError('INVALID_INPUT','Recipe URL must be public HTTPS without credentials or a custom port.');
  const addresses=await lookupFn(url.hostname,{all:true,family:4});
  if(!addresses.length||addresses.some(x=>!publicIPv4(x.address)))throw new CapabilityError('INVALID_INPUT','Recipe URL resolves to a non-public address.');
  return {url,address:addresses[0].address};
}
export async function fetchRecipeHtml(value,redirects=0) {
  if(redirects>4)throw new CapabilityError('UPSTREAM_FAILURE','Too many recipe redirects.');
  const {url,address}=await validateRecipeUrl(value);
  return new Promise((resolve,reject)=>{
    // Pin the validated address for this request; Host/SNI remain the original hostname.
    const req=https.get(url,{lookup:(_h,options,cb)=>cb(null,options?.all?[{address,family:4}]:address,4),headers:{'User-Agent':'AnyList-MCP recipe import','Accept':'text/html,application/xhtml+xml'},timeout:10000},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();fetchRecipeHtml(new URL(res.headers.location,url).href,redirects+1).then(resolve,reject);return;}
      if(res.statusCode!==200){res.resume();reject(new CapabilityError('UPSTREAM_FAILURE','Recipe website returned an error.'));return;}
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){req.destroy(new CapabilityError('UPSTREAM_FAILURE','Recipe document exceeds 2 MiB.'));return;}chunks.push(chunk);});
      res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));res.on('error',reject);
    });
    const deadline=setTimeout(()=>req.destroy(new CapabilityError('UPSTREAM_FAILURE','Recipe fetch timed out.')),12000);
    req.on('close',()=>clearTimeout(deadline));req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));
  });
}
