import { writeFileSync } from 'node:fs'

export function logger(path: string): (line: string) => void {
  writeFileSync(path, '', { flag: 'a' })
  return (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`
    process.stdout.write(text)
    writeFileSync(path, text, { flag: 'a' })
  }
}
