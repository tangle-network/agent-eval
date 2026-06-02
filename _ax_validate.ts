import { ai } from '@ax-llm/ax'
import { AnalystRegistry } from './src/analyst/registry'
import { createTraceAnalystKind } from './src/analyst/kind-factory'
import { FAILURE_MODE_KIND_SPEC, IMPROVEMENT_KIND_SPEC } from './src'
import { OtlpFileTraceStore } from './src/trace-analyst/store-otlp'
const t0 = Date.now()
const aiSvc = ai({ name: 'openai', apiKey: process.env.DEEPSEEK_API_KEY!, apiURL: 'https://api.deepseek.com/v1', config: { model: 'deepseek-chat' } })
const reg = new AnalystRegistry()
reg.register(createTraceAnalystKind(FAILURE_MODE_KIND_SPEC, { ai: aiSvc, model: 'deepseek-chat' }))
reg.register(createTraceAnalystKind(IMPROVEMENT_KIND_SPEC, { ai: aiSvc, model: 'deepseek-chat' }))
const res = await reg.run('ax-validate', { traceStore: new OtlpFileTraceStore({ path: process.argv[2] }) })
console.log(`AX-RLM on deepseek-chat — ${((Date.now()-t0)/1000).toFixed(0)}s`)
console.log('per_analyst:', JSON.stringify(res.per_analyst))
console.log('total findings:', res.findings.length)
for (const f of res.findings.slice(0,6)) console.log(`  - [${f.severity}] ${f.area}/${f.subject}: ${(f.claim||'').slice(0,90)}`)
