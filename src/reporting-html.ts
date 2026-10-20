/** Safe HTML text and standalone documents rendered from report Markdown. */

export function renderResearchHtml(markdown: string, title: string): string {
  const body = markdownToHtml(markdown)
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;color:#172026;background:#f7f8f8;}',
    'main{max-width:1080px;margin:0 auto;padding:40px 24px 64px;background:#fff;min-height:100vh;}',
    'h1{font-size:34px;line-height:1.15;margin:0 0 20px;}h2{margin-top:34px;border-top:1px solid #d9dfdf;padding-top:22px;}h3{margin-top:22px;}',
    'p,li{line-height:1.55;}table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;}th,td{border:1px solid #d9dfdf;padding:8px;text-align:left;}th{background:#eef2f2;}',
    'code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}pre{overflow:auto;background:#111827;color:#f9fafb;padding:16px;border-radius:6px;}',
    '</style>',
    '</head>',
    '<body><main>',
    body,
    '</main></body></html>',
  ].join('\n')
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n')
  const html: string[] = []
  let inList = false
  let inCode = false
  let code: string[] = []
  let table: string[] = []

  const flushList = () => {
    if (inList) {
      html.push('</ul>')
      inList = false
    }
  }
  const flushTable = () => {
    if (table.length === 0) return
    html.push(renderMarkdownTable(table))
    table = []
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        code = []
        inCode = false
      } else {
        flushList()
        flushTable()
        inCode = true
      }
      continue
    }
    if (inCode) {
      code.push(line)
      continue
    }
    if (line.startsWith('|')) {
      flushList()
      table.push(line)
      continue
    }
    flushTable()
    if (line.startsWith('- ')) {
      if (!inList) {
        html.push('<ul>')
        inList = true
      }
      html.push(`<li>${inlineMarkdown(line.slice(2))}</li>`)
      continue
    }
    flushList()
    if (line.startsWith('# ')) html.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`)
    else if (line.startsWith('## ')) html.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`)
    else if (line.startsWith('### ')) html.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`)
    else if (line.trim() === '') html.push('')
    else html.push(`<p>${inlineMarkdown(line)}</p>`)
  }
  flushList()
  flushTable()
  return html.join('\n')
}

function renderMarkdownTable(lines: string[]): string {
  const rows = lines
    .filter((line) => !/^\|[-:\s|]+\|$/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => inlineMarkdown(cell.trim())),
    )
  if (rows.length === 0) return ''
  const [head, ...body] = rows
  const th = head!.map((cell) => `<th>${cell}</th>`).join('')
  const trs = body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('\n')
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`
}

function inlineMarkdown(s: string): string {
  return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
