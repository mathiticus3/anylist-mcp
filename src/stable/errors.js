export class CapabilityError extends Error {
  constructor(code,message,candidates=[]) {super(message);this.code=code;this.candidates=candidates;}
}
export function resolve(resources,{id,name},kind) {
  if (!id && !name) throw new CapabilityError('INVALID_INPUT',`Provide ${kind} ID or name.`);
  const matches = resources.filter(r=> id ? r.identifier === id : (r.name || '').trim().toLowerCase() === name.trim().toLowerCase());
  if (!matches.length) throw new CapabilityError('NOT_FOUND',`${kind} not found.`);
  if (matches.length !== 1) throw new CapabilityError('AMBIGUOUS',`Multiple ${kind} matches; select an ID.`,matches.map(r=>({id:r.identifier,name:r.name})));
  if (id && name && (matches[0].name || '').trim().toLowerCase() !== name.trim().toLowerCase()) throw new CapabilityError('INVALID_INPUT',`${kind} ID and name disagree.`);
  return matches[0];
}
export function failure(error) {
  if (error instanceof CapabilityError) return {ok:false,error:{code:error.code,message:error.message,candidates:error.candidates}};
  if (error?.name === 'ZodError') return {ok:false,error:{code:'INVALID_INPUT',message:'Input does not match the action schema.',fields:error.issues.map(i=>i.path.join('.'))}};
  const status=error?.response?.statusCode || error?.status;
  return {ok:false,error:{code:status===401 || status===403 ? 'AUTH_FAILURE' : 'UPSTREAM_FAILURE',message:status===401 || status===403 ? 'AnyList authentication failed.' : 'AnyList operation failed. Refresh and read current state before retrying a write.'}};
}
const queues=new WeakMap();
export async function withClientLock(client,fn) {
  const previous=queues.get(client)||Promise.resolve();
  const next=previous.catch(()=>{}).then(fn);
  queues.set(client,next);
  try{return await next;} finally {if(queues.get(client)===next) queues.delete(client);}
}
