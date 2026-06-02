import { ai } from '@ax-llm/ax'
import { AnalystRegistry } from './src/analyst/registry'
import { createTraceAnalystKind } from './src/analyst/kind-factory'
import { FAILURE_MODE_KIND_SPEC, IMPROVEMENT_KIND_SPEC } from './src'
import { OtlpFileTraceStore } from './src/trace-analyst/store-otlp'
const t0 = Date.now()
const key = process.env.DEEPSEEK_API_KEY!
const aiSvc = ai({ name: 'openai', apiKey: key, apiURL: 'https://api.deepseek.com/v1', config: { model: 'deepseek-chat' } })
const recovery = { baseUrl: 'https://api.deepseek.com/v1', apiKey: key, model: 'deepseek-chat' }
const reg = new AnalystRegistry()
reg.register(createTraceAnalystKind(FAILURE_MODE_KIND_SPEC, { ai: aiSvc, model: 'deepseek-chat', recovery }))
reg.register(createTraceAnalystKind(IMPROVEMENT_KIND_SPEC, { ai: aiSvc, model: 'deepseek-chat', recovery }))
const res = await reg.run('gen4', { traceStore: new OtlpFileTraceStore({ path: process.argv[2] }) })
console.log(`GEN4 two-phase on deepseek-chat — ${((Date.now()-t0)/1000).toFixed(0)}s`)
console.log('per_analyst:', JSON.stringify(res.per_analyst))
console.log('total findings:', res.findings.length)
for (const f of res.findings) console.log(`  - [${f.severity}] ${f.area}/${f.subject ?? '(none)'} ${String(f.metadata?.outcome ?? '')}: ${(f.claim||'').slice(0,80)}`)
