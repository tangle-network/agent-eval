// The one reader of pnpm-lock.yaml's block structure: every key in each YAML
// document, with its path from the document root and its inline value ('' when
// the key opens a nested block). Quotes around keys and scalar values are removed.
const KEY = /^( *)(['"]?)([^'":\s][^'":]*)\2:(?:\s+(\S.*))?$/

export function pnpmLockDocuments(text) {
  const documents = [[]]
  const path = []
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line === '---') {
      if (documents.at(-1).length > 0) documents.push([])
      path.length = 0
      continue
    }
    const match = KEY.exec(line)
    if (!match) continue
    const depth = match[1].length / 2
    path.length = depth
    path[depth] = match[3]
    documents.at(-1).push({ path: [...path], value: (match[4] ?? '').replace(/^(['"])(.*)\1$/, '$2') })
  }
  return documents.filter((document) => document.length > 0)
}
