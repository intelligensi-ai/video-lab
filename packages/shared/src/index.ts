export type Problem = { type:string; title:string; status:number; detail:string; code:string; traceId:string; fieldErrors?: unknown[] };
export const traceId = () => `trace_${Date.now()}_${Math.random().toString(16).slice(2)}`;
export function problem(status:number, code:string, detail:string, id=traceId()): Problem { return { type:`https://trial.intelligensi.ai/problems/${code}`, title: code.replaceAll('_',' '), status, detail, code, traceId:id }; }
export const nowIso = () => new Date().toISOString();
export function log(event:string, fields:Record<string, unknown>={}) { console.log(JSON.stringify({event, time:nowIso(), ...fields})); }
