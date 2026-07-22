export type GenerationStatus = 'queued'|'preparing'|'generating'|'uploading'|'completed'|'failed'|'cancelled';
export interface VideoSettings { aspectRatio:'16:9'|'9:16'|'1:1'; durationSeconds:4|8|12; quality:'draft'|'standard'|'high'; seed?:number }
export interface Generation { id:string; prompt:string; settings:VideoSettings; inputAssets?:unknown[]; status:GenerationStatus; queuePosition?:number; creditCost:number; output?:{downloadUrl?:string;thumbnailUrl?:string;durationSeconds?:number}; safeErrorMessage?:string; createdAt:string; updatedAt:string }
export interface CreditWallet { uid:string; available:number; reserved:number; spent:number; updatedAt:string; version:number }
export interface Me { uid:string; email:string; displayName?:string; photoURL?:string; status:'active'|'suspended'; roles:string[]; termsVersion:string; trialGrantedAt?:string }
export interface RuntimeStatus { provider:string; status:'healthy'|'degraded'|'unavailable'|'paused'; acceptingSubmissions:boolean; killSwitch:boolean; lastHeartbeatAt?:string; activeGenerationId?:string; queueDepth:number; updatedAt:string }
export interface RuntimeHealth { ok:boolean; provider:string; message?:string }
export interface RuntimeConnectRequest { lambdaIp?:string; baseUrl?:string }
export type RuntimeConnectResponse = RuntimeStatus & { baseUrl:string; health?:RuntimeHealth };
