import express from 'express';import cors from 'cors';import swaggerUi from 'swagger-ui-express';import fs from 'node:fs';import YAML from 'yaml';import { nanoid } from 'nanoid';import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';import { getAuth } from 'firebase-admin/auth';import { MAX_STORYBOARD_SCENES } from '@video-lab/contracts';import type { CreditWallet, Generation, Me, RuntimeStatus } from '@video-lab/contracts';import { calculateCreditCost, chargeCredits, claimNext, createWallet, releaseCredits, reserveCredits, type QueueItem } from '@video-lab/domain';import { createRuntimeFromEnv, SulphurLtxRuntimeAdapter } from '@video-lab/runtime-adapter';import { log, nowIso, problem } from '@video-lab/shared';
import { getFirestore } from 'firebase-admin/firestore';import { getStorage } from 'firebase-admin/storage';
type Principal={uid:string;email:string;admin:boolean}; let runtime=createRuntimeFromEnv();
type StoredGeneration=Generation&{uid:string;runtimeJobId?:string;outputBytes?:Uint8Array;outputContentType?:string;outputObjectPath?:string};
const users=new Map<string,Me>(); const wallets=new Map<string,CreditWallet>(); const gens=new Map<string,StoredGeneration>(); const queue:QueueItem[]=[]; const idempotency=new Map<string,string>(); const assets=new Map<string,{uid:string;purpose:string;objectPath:string}>(); let runtimeState:RuntimeStatus={provider:process.env.VIDEO_RUNTIME_PROVIDER??'mock',status:'healthy',acceptingSubmissions:true,killSwitch:false,queueDepth:0,updatedAt:nowIso(),lastHeartbeatAt:nowIso()};
const base64FieldByObjectPathField:Record<string,string>={
  globalVisualAnchorObjectPath:'globalVisualAnchorBase64',
  seedFrameObjectPath:'seedFrameBase64',
  startFrameObjectPath:'startFrameBase64',
  endFrameObjectPath:'endFrameBase64',
  referenceImageObjectPath:'referenceImageBase64',
  styleReferenceObjectPath:'styleReferenceBase64',
  subjectReferenceObjectPath:'subjectReferenceBase64',
};
export function stripEmbeddedMedia(value:unknown):unknown{
  if(Array.isArray(value))return value.map(stripEmbeddedMedia);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>)
    .filter(([key])=>!key.endsWith('Base64'))
    .map(([key,nested])=>[key,stripEmbeddedMedia(nested)]));
}
function publicGeneration(g:StoredGeneration):Generation{ const {uid:_uid,runtimeJobId:_runtimeJobId,outputBytes:_outputBytes,outputContentType:_outputContentType,outputObjectPath:_outputObjectPath,...generation}=g; return {...generation,settings:stripEmbeddedMedia(generation.settings) as Generation['settings']}; }
function isOwnedUploadPath(value:string,uid:string){return value.startsWith(`users/${uid}/uploads/`)&&!value.includes('..')&&!value.includes('\\')&&!value.includes('\0');}
function validateAssetReferences(value:unknown,uid:string):void{
  if(Array.isArray(value)){value.forEach(item=>validateAssetReferences(item,uid));return;}
  if(!value||typeof value!=='object')return;
  for(const [key,nested] of Object.entries(value as Record<string,unknown>)){
    if(key in base64FieldByObjectPathField){
      if(typeof nested!=='string'||!isOwnedUploadPath(nested,uid))throw problem(403,'asset_forbidden','Asset is not owned by caller');
    }else validateAssetReferences(nested,uid);
  }
}
async function uploadedAssetDataUrl(objectPath:string,uid:string){
  if(!isOwnedUploadPath(objectPath,uid))throw problem(403,'asset_forbidden','Asset is not owned by caller');
  adminApp();const file=getStorage().bucket().file(objectPath);const [[metadata],[bytes]]=await Promise.all([file.getMetadata(),file.download()]);
  const contentType=typeof metadata.contentType==='string'&&metadata.contentType.startsWith('image/')?metadata.contentType:'image/png';
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}
async function hydrateAssetReferences(value:unknown,uid:string):Promise<unknown>{
  if(Array.isArray(value))return Promise.all(value.map(item=>hydrateAssetReferences(item,uid)));
  if(!value||typeof value!=='object')return value;
  const hydrated=Object.fromEntries(await Promise.all(Object.entries(value as Record<string,unknown>).map(async([key,nested])=>[key,await hydrateAssetReferences(nested,uid)])));
  await Promise.all(Object.entries(base64FieldByObjectPathField).map(async([objectPathField,base64Field])=>{
    const objectPath=hydrated[objectPathField];
    if(typeof objectPath==='string'&&typeof hydrated[base64Field]!=='string')hydrated[base64Field]=await uploadedAssetDataUrl(objectPath,uid);
  }));
  return hydrated;
}
async function runtimeGeneration(g:StoredGeneration):Promise<StoredGeneration>{
  if(localAuth)return g;
  return {...g,settings:await hydrateAssetReferences(g.settings,g.uid) as Generation['settings']};
}
function normalizeRuntimeBaseUrl(value:unknown){ if(typeof value!=='string') return undefined; const trimmed=value.trim(); if(!trimmed) return undefined; const withProtocol=/^https?:\/\//i.test(trimmed)?trimmed:`http://${trimmed}`; try{ const url=new URL(withProtocol); if(!['http:','https:'].includes(url.protocol)) return undefined; if(!url.hostname||['localhost','127.0.0.1','0.0.0.0','::1'].includes(url.hostname)) return undefined; url.username=''; url.password=''; url.pathname=''; url.search=''; url.hash=''; return url.toString().replace(/\/$/,''); }catch{return undefined;}}
let runtimeBaseUrl=normalizeRuntimeBaseUrl(process.env.VIDEO_RUNTIME_BASE_URL);
const localAuth=process.env.NODE_ENV==='test'||(process.env.NODE_ENV!=='production'&&!process.env.K_SERVICE);
type RuntimeDiscovery=NonNullable<RuntimeStatus['discovery']>;
let runtimeDiscovery:RuntimeDiscovery={source:runtimeBaseUrl?'environment':'none',state:runtimeBaseUrl?'waiting':'unavailable',message:runtimeBaseUrl?'Configured from the server environment':'Waiting for Deploy Studio'};
let runtimeDiscoveryCheckedAt=0;
let runtimeDiscoveryPromise:Promise<void>|undefined;
const runtimeDiscoveryRefreshMs=Math.max(2_000,Number(process.env.VIDEO_RUNTIME_DISCOVERY_REFRESH_MS??10_000));
export function creditLimitsEnabled(_env:NodeJS.ProcessEnv=process.env){return false;}
const adminEmails=new Set((process.env.ADMIN_EMAILS??'').split(',').map(email=>email.trim().toLowerCase()).filter(Boolean));
export function firebaseStorageBucket(env:NodeJS.ProcessEnv=process.env){if(env.FIREBASE_STORAGE_BUCKET?.trim())return env.FIREBASE_STORAGE_BUCKET.trim();try{const config=JSON.parse(env.FIREBASE_CONFIG??'{}') as {storageBucket?:unknown};if(typeof config.storageBucket==='string'&&config.storageBucket.trim())return config.storageBucket.trim();}catch{/* Fall through to the project-derived bucket. */}const projectId=env.GCLOUD_PROJECT??env.GOOGLE_CLOUD_PROJECT;return projectId?`${projectId}.firebasestorage.app`:undefined;}
function adminApp(){if(!getApps().length) initializeApp({credential:applicationDefault(),storageBucket:firebaseStorageBucket()});}
function createRuntimeAdapter(baseUrl:string){return new SulphurLtxRuntimeAdapter({baseUrl,token:process.env.VIDEO_RUNTIME_API_TOKEN,healthPath:process.env.VIDEO_RUNTIME_HEALTH_PATH??'/health',submitPath:process.env.VIDEO_RUNTIME_SUBMIT_PATH,statusPath:process.env.VIDEO_RUNTIME_STATUS_PATH,cancelPath:process.env.VIDEO_RUNTIME_CANCEL_PATH,outputPath:process.env.VIDEO_RUNTIME_OUTPUT_PATH,authHeaderName:process.env.VIDEO_RUNTIME_AUTH_HEADER,authScheme:process.env.VIDEO_RUNTIME_AUTH_SCHEME,payloadMode:process.env.VIDEO_RUNTIME_PAYLOAD_MODE==='sulphur'?'sulphur':'deploy-studio',timeoutMs:Number(process.env.VIDEO_RUNTIME_TIMEOUT_MS??120000)});}
function discoveryDate(value:unknown){if(value instanceof Date)return value;if(typeof value==='string'||typeof value==='number'){const date=new Date(value);return Number.isNaN(date.getTime())?undefined:date;}if(value&&typeof value==='object'&&'toDate'in value&&typeof (value as {toDate?:unknown}).toDate==='function')return (value as {toDate:()=>Date}).toDate();return undefined;}
function useRuntimeEndpoint(baseUrl:string,source:RuntimeDiscovery['source']){if(runtimeBaseUrl!==baseUrl){runtimeBaseUrl=baseUrl;runtime=createRuntimeAdapter(baseUrl);log('runtime_endpoint_discovered',{source});}if(runtimeState.provider==='mock')runtimeState={...runtimeState,provider:'sulphur-ltx',updatedAt:nowIso()};}
function clearRuntimeEndpoint(discovery:RuntimeDiscovery){runtimeBaseUrl=undefined;runtimeDiscovery=discovery;if(runtimeState.status!=='paused'&&!runtimeState.killSwitch)runtimeState={...runtimeState,status:'unavailable',acceptingSubmissions:false,updatedAt:nowIso()};}
async function loadRuntimeDiscovery(force=false){
  if(localAuth)return;
  const now=Date.now();
  if(!force&&now-runtimeDiscoveryCheckedAt<runtimeDiscoveryRefreshMs)return;
  if(runtimeDiscoveryPromise)return runtimeDiscoveryPromise;
  runtimeDiscoveryPromise=(async()=>{
    adminApp();
    const firestore=getFirestore();
    const snapshot=await firestore.collection(process.env.VIDEO_RUNTIME_DISCOVERY_COLLECTION??'runtimeDiscovery').doc(process.env.VIDEO_RUNTIME_DISCOVERY_DOCUMENT??'current').get();
    runtimeDiscoveryCheckedAt=Date.now();
    if(snapshot.exists){
      const data=snapshot.data()??{};
      const status=String(data.status??'').toLowerCase();
      const baseUrl=normalizeRuntimeBaseUrl(data.baseUrl);
      const heartbeatAt=discoveryDate(data.heartbeatAt);
      const leaseExpiresAt=discoveryDate(data.leaseExpiresAt);
      const instanceId=typeof data.instanceId==='string'?data.instanceId:undefined;
      const details={source:'deploy-studio' as const,instanceId,lastPublishedAt:heartbeatAt?.toISOString(),leaseExpiresAt:leaseExpiresAt?.toISOString()};
      if(status!=='ready'){clearRuntimeEndpoint({...details,state:'waiting',message:`Deploy Studio reports ${status||'no status'}`});return;}
      if(!leaseExpiresAt||leaseExpiresAt.getTime()<=Date.now()){clearRuntimeEndpoint({...details,state:'stale',message:'Deploy Studio runtime lease expired'});return;}
      if(!baseUrl){clearRuntimeEndpoint({...details,state:'unavailable',message:'Deploy Studio did not publish a valid runtime origin'});return;}
      useRuntimeEndpoint(baseUrl,'deploy-studio');
      runtimeDiscovery={...details,state:'connected',message:'Deploy Studio runtime lease is current'};
      return;
    }
    const environmentUrl=normalizeRuntimeBaseUrl(process.env.VIDEO_RUNTIME_BASE_URL);
    if(environmentUrl){useRuntimeEndpoint(environmentUrl,'environment');runtimeDiscovery={source:'environment',state:'connected',message:'Using server environment fallback'};return;}
    const legacy=await firestore.collection('runtimeState').doc('config').get();
    const legacyUrl=legacy.exists?normalizeRuntimeBaseUrl(legacy.data()?.baseUrl):undefined;
    if(legacyUrl){useRuntimeEndpoint(legacyUrl,'legacy');runtimeDiscovery={source:'legacy',state:'connected',message:'Using migration fallback until Deploy Studio publishes a lease'};return;}
    clearRuntimeEndpoint({source:'none',state:'unavailable',message:'Waiting for Deploy Studio to publish a runtime lease'});
  })().catch(error=>{runtimeDiscoveryCheckedAt=Date.now();clearRuntimeEndpoint({source:'none',state:'unavailable',message:'Runtime discovery could not be refreshed'});log('runtime_discovery_failed',{error:error instanceof Error?error.message:String(error)});throw error;}).finally(()=>{runtimeDiscoveryPromise=undefined;});
  return runtimeDiscoveryPromise;
}
async function ensureRuntimeConfiguration(){await loadRuntimeDiscovery();}
async function refreshRuntimeHealth(){if(!runtimeBaseUrl||runtimeState.provider==='mock'||runtimeState.killSwitch||runtimeState.status==='paused')return;try{const health=await runtime.healthCheck();runtimeState={...runtimeState,provider:health.provider,status:health.ok?'healthy':'unavailable',acceptingSubmissions:health.ok,lastHeartbeatAt:health.ok?nowIso():runtimeState.lastHeartbeatAt,updatedAt:nowIso()};}catch(e){runtimeState={...runtimeState,status:'unavailable',acceptingSubmissions:false,updatedAt:nowIso()};log('runtime_health_failed',{error:e instanceof Error?e.message:String(e)});}}
function publicRuntimeStatus():RuntimeStatus{return {...runtimeState,queueDepth:queue.filter(q=>q.status!=='done').length,discovery:runtimeDiscovery};}
async function persistGeneration(g:StoredGeneration){if(localAuth)return;adminApp();const clean=JSON.parse(JSON.stringify({...publicGeneration(g),uid:g.uid,runtimeJobId:g.runtimeJobId,outputObjectPath:g.outputObjectPath,outputContentType:g.outputContentType}));await getFirestore().collection('generations').doc(g.id).set(clean,{merge:true});}
async function findGeneration(id:string){const memory=gens.get(id);if(memory||localAuth)return memory;adminApp();const snapshot=await getFirestore().collection('generations').doc(id).get();if(!snapshot.exists)return undefined;const generation=snapshot.data() as StoredGeneration;gens.set(id,generation);return generation;}
async function principal(req:express.Request):Promise<Principal>{ const h=req.header('authorization'); if(!h?.startsWith('Bearer ')) throw problem(401,'unauthenticated','Missing Firebase bearer token'); const token=h.slice(7); if(localAuth){ if(token==='admin-token') return {uid:'admin',email:'admin@example.test',admin:true}; return {uid:token.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,64)||'demo',email:`${token}@example.test`,admin:false}; } try{ adminApp(); const decoded=await getAuth().verifyIdToken(token); const email=decoded.email??`${decoded.uid}@firebase.local`; return {uid:decoded.uid,email,admin:decoded.admin===true||adminEmails.has(email.toLowerCase())}; }catch{ throw problem(401,'unauthenticated','Invalid or expired Firebase bearer token'); }}
function ensureUser(p:Principal){ let u=users.get(p.uid); if(!u){u={uid:p.uid,email:p.email,status:'active',roles:p.admin?['admin']:[],termsVersion:'2026-07',trialGrantedAt:nowIso()}; users.set(p.uid,u); wallets.set(p.uid,createWallet(p.uid,12)); log('user_initialized',{uid:p.uid});} return u;}
async function auth(req:express.Request,res:express.Response,next:express.NextFunction){try{const p=await principal(req); ensureUser(p); res.locals.principal=p; next();}catch(e){next(e)}}
async function admin(req:express.Request,res:express.Response,next:express.NextFunction){try{const p=await principal(req); ensureUser(p); if(!p.admin) throw problem(403,'admin_required','Administrator access required'); res.locals.principal=p; next();}catch(e){next(e)}}
export const app: express.Express=express(); app.use(cors()); app.use(express.json({limit:'32mb'})); app.use((req,_res,next)=>{ if(req.url==='/api'||req.url.startsWith('/api/')) req.url=req.url.slice(4)||'/'; next(); });
if(process.env.NODE_ENV!=='production'){ const doc=YAML.parse(fs.readFileSync(new URL('../../../contracts/video-lab.openapi.yaml',import.meta.url),'utf8')); app.use('/docs',swaggerUi.serve,swaggerUi.setup(doc));}
app.get('/v1/health',(_req,res)=>res.json({ok:true,service:'video-lab-api',version:'0.1.0'}));
app.get('/v1/me',auth,(req,res)=>res.json(users.get(res.locals.principal.uid)));
app.get('/v1/credits',auth,(req,res)=>res.json(wallets.get(res.locals.principal.uid)));
app.post('/v1/prompts/complete',auth,async(req,res,next)=>{try{await ensureRuntimeConfiguration();const prompt=String(req.body?.prompt??'').trim();const mode=String(req.body?.mode??'expand');if(prompt.length<3||prompt.length>2400)throw problem(400,'invalid_prompt','Prompt must be 3-2400 characters');if(mode!=='expand')throw problem(400,'invalid_prompt_mode','Prompt mode must be expand');if(!runtimeBaseUrl&&runtimeState.provider!=='mock')throw problem(503,'runtime_unavailable','Connect the Sulphur runtime to develop prompts');const result=await runtime.completePrompt(prompt,'expand');log('runtime_prompt_completed',{uid:res.locals.principal.uid,provider:result.provider,promptChars:prompt.length,resultChars:result.completedPrompt.length});res.json(result);}catch(e){next(e)}});
app.post('/v1/assets/upload-url',auth,(req,res,next)=>{try{const {fileName,contentType,sizeBytes,purpose}=req.body; if(!['image/jpeg','image/png','image/webp'].includes(contentType)||sizeBytes>10485760) throw problem(400,'invalid_asset','Unsupported image type or size'); const assetId=nanoid(); const objectPath=`users/${res.locals.principal.uid}/uploads/${assetId}-${String(fileName).replace(/[^\w.-]/g,'_')}`; assets.set(assetId,{uid:res.locals.principal.uid,purpose,objectPath}); res.status(201).json({assetId,uploadUrl:`http://localhost:9199/upload/${objectPath}`,method:'PUT',expiresAt:new Date(Date.now()+10*60_000).toISOString(),objectPath});}catch(e){next(e)}});
app.post('/v1/generations',auth,async(req,res,next)=>{try{await ensureRuntimeConfiguration();if(!runtimeState.acceptingSubmissions&&runtimeState.status==='unavailable'&&!runtimeState.killSwitch)await refreshRuntimeHealth();const p=res.locals.principal as Principal; const key=req.header('idempotency-key'); if(!key||key.length<8) throw problem(400,'idempotency_key_required','Idempotency-Key header is required'); const idem=`${p.uid}_${key}`; const existing=idempotency.get(idem); if(existing) {log('generation_idempotent_replay',{uid:p.uid,generationId:existing}); const replay=gens.get(existing);return replay?res.json(publicGeneration(replay)):res.status(404).end();} if(!runtimeState.acceptingSubmissions||runtimeState.killSwitch||!runtimeBaseUrl&&runtimeState.provider!=='mock') throw problem(503,'runtime_paused','Submissions are paused'); const active=[...gens.values()].find(g=>g.uid===p.uid&&['queued','preparing','generating','uploading'].includes(g.status)); if(active) throw problem(409,'active_generation_exists','Only one active generation is allowed'); const {prompt,settings,inputAssets=[]}=req.body; if(!prompt||prompt.length<8||prompt.length>1200) throw problem(400,'invalid_prompt','Prompt must be 8-1200 characters');validateAssetReferences(settings,p.uid); const storyboard=(settings as {storyboard?:unknown})?.storyboard;if(Array.isArray(storyboard)&&storyboard.length>MAX_STORYBOARD_SCENES)throw problem(400,'scene_limit_exceeded',`Storyboard supports up to ${MAX_STORYBOARD_SCENES} scenes per generation`); for(const a of inputAssets){ if(assets.get(a.assetId)?.uid!==p.uid) throw problem(403,'asset_forbidden','Asset is not owned by caller'); } const cost=0; log('generation_credit_free',{uid:p.uid}); const id=nanoid(); const gen:StoredGeneration={id,uid:p.uid,prompt,settings,inputAssets,status:'queued' as const,creditCost:cost,createdAt:nowIso(),updatedAt:nowIso(),queuePosition:queue.length+1}; gens.set(id,gen); await persistGeneration(gen); queue.push({generationId:id,createdAt:gen.createdAt,status:'queued',attempt:0}); runtimeState={...runtimeState,queueDepth:queue.filter(q=>q.status!=='done').length,updatedAt:nowIso()}; idempotency.set(idem,id); log('generation_submitted',{uid:p.uid,generationId:id}); res.status(201).json(publicGeneration(gen)); if(process.env.NODE_ENV!=='test'&&process.env.NODE_ENV!=='production'&&!process.env.FUNCTION_TARGET&&!process.env.K_SERVICE) void processOne('local-auto-worker');}catch(e){next(e)}});
app.get('/v1/generations/:id',auth,async(req,res,next)=>{try{const id=String(req.params.id??''); const g=await findGeneration(id); if(!g||g.uid!==res.locals.principal.uid) throw problem(404,'not_found','Generation not found'); res.json(publicGeneration(g));}catch(e){next(e)}});
app.get('/v1/generations/:id/download',auth,async(req,res,next)=>{try{const id=String(req.params.id??''); const g=await findGeneration(id); if(!g||g.uid!==res.locals.principal.uid) throw problem(404,'not_found','Generation not found'); res.type(g.outputContentType??'video/mp4').setHeader('Content-Disposition',`attachment; filename="${g.id}.mp4"`); if(g.outputBytes)return res.send(Buffer.from(g.outputBytes)); if(!g.outputObjectPath)throw problem(404,'output_not_available','Generation output is not available for download'); adminApp();const file=getStorage().bucket().file(g.outputObjectPath);const [exists]=await file.exists();if(!exists)throw problem(404,'output_not_available','Generation output is not available for download');file.createReadStream().on('error',next).pipe(res);}catch(e){next(e)}});
app.post('/v1/generations/:id/cancel',auth,async(req,res,next)=>{try{const id=String(req.params.id??''); const g=await findGeneration(id); if(!g||g.uid!==res.locals.principal.uid) throw problem(404,'not_found','Generation not found'); if(['completed','failed','cancelled'].includes(g.status)) return res.json(publicGeneration(g)); if(g.runtimeJobId){try{await runtime.cancelGeneration(g.runtimeJobId);}catch(e){log('runtime_cancel_failed',{generationId:g.id,error:e instanceof Error?e.message:String(e)});}} const wallet=wallets.get(g.uid);if(creditLimitsEnabled()&&wallet&&wallet.reserved>=g.creditCost)wallets.set(g.uid,releaseCredits(wallet,g.creditCost)); const ng:StoredGeneration={...g,status:'cancelled' as const,updatedAt:nowIso(),safeErrorMessage:'Cancelled by user'}; gens.set(g.id,ng);await persistGeneration(ng); const q=queue.find(i=>i.generationId===g.id); if(q) q.status='done'; log('generation_cancelled',{uid:g.uid,generationId:g.id}); res.json(publicGeneration(ng));}catch(e){next(e)}});
app.get('/v1/gallery',auth,async(req,res,next)=>{try{const p=res.locals.principal as Principal; const status=req.query.status; if(!localAuth){adminApp();let query=getFirestore().collection('generations').where('uid','==',p.uid).orderBy('createdAt','desc').limit(Number(req.query.limit??20));const snapshot=await query.get();const items=snapshot.docs.map(doc=>doc.data() as StoredGeneration).filter(g=>!status||g.status===status).map(publicGeneration);return res.json({items});} const items=[...gens.values()].filter(g=>g.uid===p.uid&&(!status||g.status===status)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,Number(req.query.limit??20)).map(publicGeneration); res.json({items});}catch(e){next(e)}});
app.get('/v1/runtime/status',auth,async(_req,res,next)=>{try{await ensureRuntimeConfiguration();await refreshRuntimeHealth();res.json(publicRuntimeStatus());}catch(e){next(e)}});
app.post('/v1/admin/runtime/discover',admin,async(_req,res,next)=>{try{runtimeDiscoveryCheckedAt=0;await loadRuntimeDiscovery(true);await refreshRuntimeHealth();log('admin_runtime_discovery_refreshed',{source:runtimeDiscovery.source,state:runtimeDiscovery.state});res.json(publicRuntimeStatus());}catch(e){next(e)}});
app.post('/v1/admin/runtime/pause',admin,(_req,res)=>{runtimeState={...runtimeState,acceptingSubmissions:false,status:'paused',updatedAt:nowIso()}; log('admin_runtime_paused'); res.json(runtimeState)});
app.post('/v1/admin/runtime/resume',admin,(_req,res)=>{runtimeState={...runtimeState,acceptingSubmissions:true,killSwitch:false,status:'healthy',updatedAt:nowIso()}; log('admin_runtime_resumed'); res.json(runtimeState)});
app.post('/v1/admin/runtime/stop',admin,(_req,res)=>{runtimeState={...runtimeState,acceptingSubmissions:false,killSwitch:true,status:'unavailable',updatedAt:nowIso()}; log('admin_kill_switch_enabled'); res.json(runtimeState)});
app.post('/v1/admin/credits/adjust',admin,(req,res)=>{const w=wallets.get(req.body.uid)??createWallet(req.body.uid,0); const nw={...w,available:w.available+Number(req.body.amount),updatedAt:nowIso(),version:w.version+1}; wallets.set(req.body.uid,nw); log('admin_credit_adjustment',{uid:req.body.uid,amount:req.body.amount}); res.json(nw)});
export async function processOne(workerId='local-worker'){
  await ensureRuntimeConfiguration();
  const item=claimNext(queue,workerId); if(!item) return;
  const g=gens.get(item.generationId); if(!g||g.status==='cancelled'){item.status='done';return;}
  try{
    const preparing={...g,status:'preparing' as const,updatedAt:nowIso()};gens.set(g.id,preparing);await persistGeneration(preparing);
    const sub=await runtime.submitGeneration(await runtimeGeneration(g));
    let st=await runtime.getGenerationStatus(sub.runtimeJobId);
    while(!['completed','failed','cancelled'].includes(st.state)){
      const current={...gens.get(g.id)!,status:st.state,updatedAt:nowIso(),runtimeJobId:sub.runtimeJobId};gens.set(g.id,current);
      await new Promise(r=>setTimeout(r,1000));st=await runtime.getGenerationStatus(sub.runtimeJobId);
    }
    if(gens.get(g.id)?.status==='cancelled'||st.state==='cancelled'){
      const cancelled:StoredGeneration={...gens.get(g.id)!,status:'cancelled',safeErrorMessage:'Cancelled by user',updatedAt:nowIso()};
      gens.set(g.id,cancelled);await persistGeneration(cancelled);
    }else if(st.state==='completed'){
      const out=await runtime.fetchOutput(sub.runtimeJobId);
      if(creditLimitsEnabled())wallets.set(g.uid,chargeCredits(wallets.get(g.uid)!,g.creditCost));
      const outputObjectPath=`users/${g.uid}/outputs/${g.id}.mp4`;
      if(!localAuth){adminApp();await getStorage().bucket().file(outputObjectPath).save(Buffer.from(out.bytes),{resumable:false,contentType:out.contentType,metadata:{cacheControl:'private,max-age=3600'}});}
      const completed:StoredGeneration={...gens.get(g.id)!,status:'completed',output:{downloadUrl:`/api/v1/generations/${g.id}/download`,durationSeconds:out.durationSeconds},...(localAuth?{outputBytes:out.bytes}:{}),outputObjectPath,outputContentType:out.contentType,updatedAt:nowIso()};
      gens.set(g.id,completed);await persistGeneration(completed);log('runtime_generation_completed',{generationId:g.id,outputObjectPath});
    }else throw new Error(st.message??st.state);
  }catch(e){
    const detail=e instanceof Error?e.message:String(e);
    const wallet=wallets.get(g.uid);let creditsReturned=false;
    if(!creditLimitsEnabled()){
      log('generation_credit_release_bypassed',{generationId:g.id});
    }else if(wallet&&wallet.reserved>=g.creditCost){
      try{wallets.set(g.uid,releaseCredits(wallet,g.creditCost));creditsReturned=true;}
      catch(refundError){log('generation_credit_release_failed',{generationId:g.id,error:refundError instanceof Error?refundError.message:String(refundError)});}
    }else{
      log('generation_credit_release_skipped',{generationId:g.id,reserved:wallet?.reserved??0,creditCost:g.creditCost});
    }
    const failed:StoredGeneration={...(gens.get(g.id)??g),status:'failed',safeErrorMessage:localAuth?`Generation failed: ${detail}.${creditsReturned?' Credits were returned.':''}`:'Generation failed safely. Please retry when the runtime is available.',updatedAt:nowIso()};
    gens.set(g.id,failed);await persistGeneration(failed);log('generation_failed',{generationId:g.id,error:detail,creditsReturned});
  }finally{item.status='done';runtimeState={...runtimeState,queueDepth:queue.filter(q=>q.status!=='done').length,updatedAt:nowIso()};}
}
let workerPromise:Promise<void>|undefined;
async function drainQueue(){ while(queue.some(item=>item.status==='queued')) await processOne('web-triggered-worker'); }
const processNextHandler=async(_req:express.Request,res:express.Response)=>{if(!workerPromise) workerPromise=drainQueue().finally(()=>{workerPromise=undefined}); await workerPromise; res.json({ok:true})};
app.post('/v1/runtime/process-next',auth,processNextHandler);
app.post('/v1/dev/process-one',auth,processNextHandler);
app.use((err:unknown,req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(!(typeof err==='object'&&err&&'status'in err))log('unhandled_api_error',{method:req.method,path:req.path,error:err instanceof Error?err.message:String(err)});const p=typeof err==='object'&&err&&'status'in err?err as ReturnType<typeof problem>:problem(500,'internal_error','Unexpected server error'); res.status(p.status).type('application/problem+json').json(p)});
export const api=process.env.NODE_ENV==='test'?app:(await import('firebase-functions/v2/https')).onRequest({timeoutSeconds:3600,maxInstances:1},app);
if(process.env.NODE_ENV!=='test'&&process.env.NODE_ENV!=='production'&&!process.env.FUNCTION_TARGET&&!process.env.K_SERVICE) app.listen(Number(process.env.PORT??5001),()=>console.log('api listening'));
