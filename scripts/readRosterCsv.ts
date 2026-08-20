import { readFile } from 'node:fs/promises'
import { parseRosterCsv } from '../src/lib/rosterCsv'
import type { RosterStudent } from '../src/lib/showcaseRound'

// Node-side wrapper: reads the file, then defers to the SAME parser the in-browser importer uses,
// so the two paths cannot disagree about what a valid roster is. The CSV itself always lives
// outside this repository.

export interface ReadRosterOptions {
  /** Absolute or relative path to the roster CSV, outside the repository. */
  path: string
  /** Only rows whose className matches exactly are returned. */
  className: string
}

export const readRosterCsv = async ({ path, className }: ReadRosterOptions): Promise<RosterStudent[]> => {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`could not read roster CSV at ${path}: ${(error as Error).message}`)
  }
  return parseRosterCsv(raw, className)
}
