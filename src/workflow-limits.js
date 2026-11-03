export const DEFAULT_WORKFLOW_LIMITS=Object.freeze({max_steps:10000,max_iterations:1000,max_depth:25,compute_timeout_ms:1000,max_expression_chars:100000,max_context_bytes:16777216,max_result_bytes:16777216,compute_memory_mb:64});
export function resolveWorkflowLimits(script={},env=process.env){
 let defaults={};try{defaults=env.WORKFLOW_LIMITS_JSON?JSON.parse(env.WORKFLOW_LIMITS_JSON):{};}catch{throw new Error('WORKFLOW_LIMITS_JSON: некорректный JSON');}
 const result={...DEFAULT_WORKFLOW_LIMITS};
 for(const layer of [defaults,script]){
  if(!layer||typeof layer!=='object'||Array.isArray(layer))throw new Error('limits: требуется объект');
  for(const [key,value] of Object.entries(layer)){
   if(!Object.hasOwn(result,key)||!Number.isSafeInteger(value)||value<1)throw new Error('Некорректный параметр limits.'+key);
   if(key==='compute_timeout_ms'&&value>2147483647)throw new Error('limits.compute_timeout_ms превышает диапазон таймера Node.js');
   result[key]=value;
  }
 }
 if(result.compute_memory_mb<16)throw new Error('limits.compute_memory_mb: требуется не менее 16 МБ');
 return result;
}
