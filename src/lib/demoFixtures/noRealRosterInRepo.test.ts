import { describe, expect, it } from 'vitest'

// Standing guard against re-committing real student identities.
//
// A real ม.5/1 roster was briefly committed and has been removed. This test walks the whole
// tracked tree and fails if any of those identities — or a roster CSV — comes back, whether by
// a regenerated fixture, a pasted snapshot, or a doc example.
//
// It deliberately checks for the SHAPE of the leak (studentId pattern, roster CSV header) rather
// than listing the real names, because listing them here would itself re-commit them.

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.csv', '.html', '.css']
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.vite', 'coverage'])

const walk = async (dir: string): Promise<string[]> => {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    if (SKIP_DIRECTORIES.has(entry.name)) return []
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return SCAN_EXTENSIONS.some((extension) => full.endsWith(extension)) ? [full] : []
  }))
  return nested.flat()
}

const repoRoot = (): string =>
  new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

describe('no real student roster in the repository', () => {
  it('contains no pasted roster CSV data rows', async () => {
    const { readFile } = await import('node:fs/promises')
    const { relative } = await import('node:path')
    // A DATA row, not the header: an id, two name fields, a ม.x/y class label and a seat number.
    // Naming the columns (schema) is fine and appears legitimately in the CSV reader and its
    // docs; carrying an actual student row is what must never happen.
    const dataRowPattern = /^\s*\d{4,5},[^,\n]+,[^,\n]+,ม\.\d\/\d,\d+\s*$/m
    const offenders: string[] = []
    for (const file of await walk(repoRoot())) {
      if (file.includes('noRealRosterInRepo.test')) continue
      const contents = await readFile(file, 'utf8')
      if (dataRowPattern.test(contents)) offenders.push(relative(repoRoot(), file))
    }
    expect(offenders).toEqual([])
  })

  it('contains no real 5-digit school studentId literals', async () => {
    const { readFile } = await import('node:fs/promises')
    const { relative } = await import('node:path')
    // The school's ids are 5-digit strings beginning 064/065/066/071/072 — the shape used by the
    // roster that leaked. Synthetic ids (SYN-001…) and ALT- ids do not match.
    const idPattern = /['"`]0(6[4-6]\d{2}|7[12]\d{2})['"`]/
    const offenders: string[] = []
    for (const file of await walk(repoRoot())) {
      if (file.includes('noRealRosterInRepo.test')) continue
      const contents = await readFile(file, 'utf8')
      if (idPattern.test(contents)) offenders.push(relative(repoRoot(), file))
    }
    expect(offenders).toEqual([])
  })

  it('has no roster CSV committed anywhere, including public/', async () => {
    const { relative } = await import('node:path')
    const offenders = (await walk(repoRoot()))
      .filter((file) => file.endsWith('.csv') || /roster|book-match/i.test(file))
      .map((file) => relative(repoRoot(), file))
      // The generator/guard modules legitimately mention "roster" in their filenames.
      .filter((file) => !/syntheticRoster|readRosterCsv|rosterCsv|noRealRosterInRepo/.test(file))
    expect(offenders).toEqual([])
  })
})
