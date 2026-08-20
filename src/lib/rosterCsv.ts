import type { RosterStudent } from './showcaseRound'

// Parses a class roster from CSV TEXT. It never reads a file itself and never holds a roster:
// the caller supplies the text — from a file the teacher picks in the browser, or from a path the
// seed script is given — so no real identity is ever stored in this repository.
//
// Expected header (order-independent):
//   studentId,firstName,lastName,className,studentNumber

const REQUIRED_COLUMNS = ['studentId', 'firstName', 'lastName', 'className', 'studentNumber'] as const

/** UTF-8 byte-order mark, matched by code point so no invisible character sits in this source. */
const BOM = 0xFEFF

/** Minimal CSV split. The roster export has no quoted fields or embedded commas. */
const splitRow = (line: string): string[] => line.split(',').map((cell) => cell.trim())

export const parseRosterCsv = (text: string, className: string): RosterStudent[] => {
  const withoutBom = text.charCodeAt(0) === BOM ? text.slice(1) : text
  const lines = withoutBom.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) throw new Error('ไฟล์รายชื่อไม่มีข้อมูล (ต้องมีหัวตารางและอย่างน้อย 1 แถว)')

  const header = splitRow(lines[0])
  for (const column of REQUIRED_COLUMNS) {
    if (!header.includes(column)) {
      throw new Error(`ไฟล์รายชื่อขาดคอลัมน์ "${column}" (พบ: ${header.join(', ')})`)
    }
  }
  const indexOf = (column: string): number => header.indexOf(column)

  const students: RosterStudent[] = []
  for (const line of lines.slice(1)) {
    const cells = splitRow(line)
    if (cells[indexOf('className')] !== className) continue
    const studentNumber = Number(cells[indexOf('studentNumber')])
    if (!Number.isInteger(studentNumber)) {
      throw new Error(`พบเลขที่นักเรียนที่ไม่ใช่จำนวนเต็มในไฟล์รายชื่อ: ${cells[indexOf('studentNumber')]}`)
    }
    const student: RosterStudent = {
      studentId: cells[indexOf('studentId')],
      firstName: cells[indexOf('firstName')],
      lastName: cells[indexOf('lastName')],
      className: cells[indexOf('className')],
      studentNumber,
    }
    if (!student.studentId || !student.firstName || !student.lastName) {
      throw new Error(`แถวรายชื่อไม่ครบถ้วน (ต้องมี studentId, firstName, lastName): ${line}`)
    }
    students.push(student)
  }

  if (students.length === 0) {
    throw new Error(`ไม่พบนักเรียนของห้อง "${className}" ในไฟล์นี้`)
  }
  return students.sort((a, b) => a.studentNumber - b.studentNumber)
}
