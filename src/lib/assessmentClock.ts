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

// Which of the four statuses a student is in. Derived from their own progress and answer count
// plus their current question's clock — never from player.submitted, which says nothing about an
// assessment.
//
// progress is how far they got; answeredCount is how many they really answered. A student who
// timed out on some items still finishes the flow, so ‘เสร็จแล้ว’ means “reached the end”, not
// “answered all ten” — the caller shows the real count alongside.
export const resolveAssessmentStatus = (
  progress: number,
  expired: boolean,
  answeredCount: number = progress,
): AssessmentStudentStatus => {
  if (progress >= ASSESSMENT_QUESTION_COUNT) return 'เสร็จแล้ว'
  // Unfinished + expired is timed out, not merely ‘in progress’.
  if (expired) return 'หมดเวลา'
  return progress === 0 && answeredCount === 0 ? 'ยังไม่เริ่ม' : 'กำลังทำ'
}
