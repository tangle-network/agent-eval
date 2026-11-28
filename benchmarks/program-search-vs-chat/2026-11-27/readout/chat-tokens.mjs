// `node chat-tokens.mjs RUN_DIR`: a chat run's metered tokens by kind, summed over every agent's new spend in its spawn
// journal with grade-versions' rule (a row that restates its agent's running total is not new spend), for the proxy cost.
const { spawnJournal } = await import(`${process.env.DISCO_CHECKOUT}/runner/records.mjs`)
const totals = new Map(), sum = { input: 0, freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, rows: 0 }
for await (const record of spawnJournal(process.argv[2])) {
  const event = record?.event ?? record
  if (event?.kind !== 'metered' || typeof event.spend?.tokens?.input !== 'number') continue
  const t = event.spend.tokens, total = totals.get(event.id) ?? { input: 0, output: 0, rows: 0 }
  if (total.rows > 0 && t.input === total.input && (t.output ?? 0) === total.output) continue
  total.input += t.input; total.output += t.output ?? 0; total.rows += 1; totals.set(event.id, total)
  sum.input += t.input; sum.freshInput += t.freshInput ?? t.input - (t.cacheRead ?? 0); sum.cacheRead += t.cacheRead ?? 0
  sum.cacheWrite += t.cacheWrite ?? 0; sum.output += t.output ?? 0; sum.rows += 1
}
console.log(JSON.stringify(sum))
