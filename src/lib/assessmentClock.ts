import { ASSESSMENT_QUESTION_COUNT } from '../data/assessmentQuestions'

// Pure assessment-clock helpers, kept out of the component files so both the student screens and
// the teacher screens read the same formatting and the same status rules.

export const formatAssessmentClock = (remainingMs: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export type AssessmentStudentStatus = 'ยังไม่เริ่ม' | 'กำลังทำ' | 'เสร็จแล้ว' | 'หมดเวลา'

// Which of the four statuses a student is in. Derived from their own answer count plus the room's
// shared clock — never from player.submitted, which says nothing about an assessment.
export const resolveAssessmentStatus = (answeredCount: number, expired: boolean): AssessmentStudentStatus => {
  if (answeredCount >= ASSESSMENT_QUESTION_COUNT) return 'เสร็จแล้ว'
  // An unfinished student after the budget runs out is timed out, not merely "in progress".
  if (expired) return 'หมดเวลา'
  return answeredCount === 0 ? 'ยังไม่เริ่ม' : 'กำลังทำ'
}
