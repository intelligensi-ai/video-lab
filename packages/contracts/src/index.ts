export * from './generated.js';
export const MAX_STORYBOARD_SCENES = 6;
export const generationStatuses = ['queued','preparing','generating','uploading','completed','failed','cancelled'] as const;
export type GenerationStatus = (typeof generationStatuses)[number];
export interface VideoSettings { aspectRatio:'16:9'|'9:16'|'1:1'; durationSeconds:number; quality:'draft'|'standard'|'high'; seed?:number; [key:string]:unknown }
export interface Generation { id:string; prompt:string; settings:VideoSettings; inputAssets?:unknown[]; status:GenerationStatus; queuePosition?:number; progress?:number; runtimeMessage?:string; creditCost:number; output?:{downloadUrl?:string;thumbnailUrl?:string;durationSeconds?:number}; safeErrorMessage?:string; createdAt:string; updatedAt:string }
export interface CreditWallet { uid:string; available:number; reserved:number; spent:number; updatedAt:string; version:number }
export interface Me { uid:string; email:string; displayName?:string; photoURL?:string; status:'active'|'suspended'; roles:string[]; termsVersion:string; trialGrantedAt?:string }
export interface RuntimeStatus { provider:string; status:'healthy'|'degraded'|'unavailable'|'paused'; acceptingSubmissions:boolean; killSwitch:boolean; lastHeartbeatAt?:string; activeGenerationId?:string; queueDepth:number; updatedAt:string; discovery?:{source:'deploy-studio'|'environment'|'legacy'|'none';state:'connected'|'waiting'|'stale'|'unavailable';instanceId?:string;leaseExpiresAt?:string;lastPublishedAt?:string;message?:string} }
