import { readFile } from 'node:fs/promises'
import type { RosterStudent } from '../src/lib/demoFixtures/syntheticRoster'

// Reads a class roster from a CSV that lives OUTSIDE this repository.
//
// The real roster is never committed: it is read at seed time from a path the operator supplies.
// This module only knows the column shape, never any actual student.
//
// Expected header (order-independent):
//   studentId,firstName,lastName,className,studentNumber

const REQUIRED_COLUMNS = ['studentId', 'firstName', 'lastName', 'className', 'studentNumber'] as const

/** UTF-8 byte-order mark, matched by code point so no invisible character sits in this source. */
const BOM = 0xFEFF

/** Minimal CSV split. The roster export has no quoted fields or embedded commas. */
const splitRow = (line: string): string[] => line.split(',').map((cell) => cell.trim())

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

  const withoutBom = raw.charCodeAt(0) === BOM ? raw.slice(1) : raw
  const lines = withoutBom.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) throw new Error(`roster CSV at ${path} has no data rows`)

  const header = splitRow(lines[0])
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`roster CSV is missing the required column "${column}" (found: ${header.join(', ')})`)
    }
  }
  const indexOf = (column: string): number => header.indexOf(column)

  const students: RosterStudent[] = []
  for (const line of lines.slice(1)) {
    const cells = splitRow(line)
    if (cells[indexOf('className')] !== className) continue
    const studentNumber = Number(cells[indexOf('studentNumber')])
    if (!Number.isInteger(studentNumber)) {
      throw new Error(`roster row has a non-integer studentNumber: ${line}`)
    }
    students.push({
      studentId: cells[indexOf('studentId')],
      firstName: cells[indexOf('firstName')],
      lastName: cells[indexOf('lastName')],
      className: cells[indexOf('className')],
      studentNumber,
    })
  }

  if (students.length === 0) {
    throw new Error(`no rows in ${path} matched className "${className}"`)
  }
  return students.sort((a, b) => a.studentNumber - b.studentNumber)
}
