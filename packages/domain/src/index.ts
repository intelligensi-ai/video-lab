import type { CreditWallet, Generation, GenerationStatus, VideoSettings } from '@video-lab/contracts';
import { nowIso } from '@video-lab/shared';
export type LedgerType='trial_grant'|'manual_grant'|'reservation'|'reservation_release'|'generation_charge'|'refund'|'future_purchase'|'future_subscription_grant';
export interface LedgerEntry { id:string; uid:string; type:LedgerType; amount:number; generationId?:string; reason:string; createdAt:string }
export const activeStatuses: GenerationStatus[] = ['queued','preparing','generating','uploading'];
export function calculateCreditCost(s: VideoSettings): number { const q={draft:1,standard:2,high:3}[s.quality]; return Math.ceil((s.durationSeconds/4)*q*2); }
export function createWallet(uid:string, credits=12): CreditWallet { return {uid, available:credits, reserved:0, spent:0, updatedAt:nowIso(), version:1}; }
export function reserveCredits(w:CreditWallet, amount:number): CreditWallet { if (amount<=0) throw new Error('invalid_amount'); if (w.available<amount) throw new Error('insufficient_credits'); return {...w, available:w.available-amount, reserved:w.reserved+amount, updatedAt:nowIso(), version:w.version+1}; }
export function releaseCredits(w:CreditWallet, amount:number): CreditWallet { if (w.reserved<amount) throw new Error('invalid_release'); return {...w, available:w.available+amount, reserved:w.reserved-amount, updatedAt:nowIso(), version:w.version+1}; }
export function chargeCredits(w:CreditWallet, amount:number): CreditWallet { if (w.reserved<amount) throw new Error('invalid_charge'); return {...w, reserved:w.reserved-amount, spent:w.spent+amount, updatedAt:nowIso(), version:w.version+1}; }
export function canTransition(from:GenerationStatus,to:GenerationStatus): boolean { const allowed:Record<GenerationStatus,GenerationStatus[]>={queued:['preparing','cancelled','failed'],preparing:['generating','failed','cancelled'],generating:['uploading','failed','cancelled'],uploading:['completed','failed'],completed:[],failed:[],cancelled:[]}; return allowed[from].includes(to); }
export function transition(g:Generation,status:GenerationStatus): Generation { if(!canTransition(g.status,status)) throw new Error(`invalid_transition:${g.status}:${status}`); return {...g,status,updatedAt:nowIso()}; }
export interface QueueItem { generationId:string; createdAt:string; status:'queued'|'claimed'|'done'; attempt:number; claimedBy?:string; leaseExpiresAt?:string }
export function claimNext(items:QueueItem[], workerId:string, now=new Date(), leaseMs=60000): QueueItem|undefined { const eligible=items.filter(i=>i.status==='queued'||(i.status==='claimed'&&i.leaseExpiresAt&&new Date(i.leaseExpiresAt)<now)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]; if(!eligible) return undefined; eligible.status='claimed'; eligible.claimedBy=workerId; eligible.attempt+=1; eligible.leaseExpiresAt=new Date(now.getTime()+leaseMs).toISOString(); return eligible; }
export function classifyRuntimeError(e:unknown): 'transient'|'permanent' { const m=e instanceof Error?e.message:String(e); return /timeout|unavailable|network/i.test(m)?'transient':'permanent'; }
export interface PaymentCreditProvider { grantPurchasedCredits(uid:string, amount:number, externalId:string): Promise<LedgerEntry>; }
export interface EntitlementService { currentTrialCredits(uid:string): Promise<number>; }
