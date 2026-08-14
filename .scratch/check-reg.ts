import { readFileSync } from 'node:fs'
import { parseTaskOracleRegistry } from '../src/trace-repair/oracle-determinism'
const doc = JSON.parse(readFileSync('benchmarks/trace-repair/task-oracles.json', 'utf8'))
const reg = parseTaskOracleRegistry(doc)
for (const [name, v] of reg) {
  console.log(`${name.padEnd(24)} stable=${String(v.stable).padEnd(5)} flip=${(v.flipRate * 100).toFixed(2)}% n=${v.replicates}`)
  if (!v.stable) console.log('   detail:', v.detail)
}
