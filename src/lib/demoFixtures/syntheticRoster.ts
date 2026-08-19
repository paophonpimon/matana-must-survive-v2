// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  SYNTHETIC TEST ROSTER — INVENTED IDENTITIES, SAFE TO COMMIT
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
//  Thirty entirely fabricated students, used by the committed tests so the showcase generator and
//  the evidence aggregation can be verified WITHOUT any real student identity living in a public
//  repository.
//
//  Every name and id here is made up. They follow the shape of a real class roster (30 rows,
//  studentNumber 1–30, one class label) purely so the generator is exercised realistically.
//
//  The real roster is never committed. It is supplied to the seed script at run time from a CSV
//  that lives outside this repository — see scripts/seed-showcase-m51.ts.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Minimal roster identity the showcase generator needs. Satisfied by both this synthetic roster
 *  and by a row parsed from the teacher's external CSV. */
export interface RosterStudent {
  studentId: string
  firstName: string
  lastName: string
  className: string
  studentNumber: number
}

/** Class label used by the synthetic roster. Not an identity — just a grouping string. */
export const SYNTHETIC_CLASS_NAME = 'ม.5/1'

// Fabricated given names / surnames. Deliberately generic and obviously synthetic.
const GIVEN_NAMES = [
  'ทดสอบหนึ่ง', 'ทดสอบสอง', 'ทดสอบสาม', 'ทดสอบสี่', 'ทดสอบห้า',
  'ทดสอบหก', 'ทดสอบเจ็ด', 'ทดสอบแปด', 'ทดสอบเก้า', 'ทดสอบสิบ',
]
const FAMILY_NAMES = ['ตัวอย่าง', 'สมมติ', 'จำลอง']

/**
 * Thirty synthetic students, studentNumber 1–30, ids SYN-001 … SYN-030.
 *
 * Generated rather than written out: there is nothing to audit by eye here, because none of it is
 * real. (The REAL roster, by contrast, is never generated and never committed.)
 */
export const SYNTHETIC_ROSTER: RosterStudent[] = Array.from({ length: 30 }, (_, index) => {
  const studentNumber = index + 1
  return {
    studentId: `SYN-${String(studentNumber).padStart(3, '0')}`,
    firstName: `${GIVEN_NAMES[index % GIVEN_NAMES.length]}`,
    lastName: `${FAMILY_NAMES[index % FAMILY_NAMES.length]}`,
    className: SYNTHETIC_CLASS_NAME,
    studentNumber,
  }
})

/** Display name, formatted the same way the seed script formats a real roster row. */
export const rosterDisplayName = (student: RosterStudent): string =>
  `${student.firstName} ${student.lastName}`
