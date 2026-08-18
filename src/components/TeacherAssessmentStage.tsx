import type { ReactNode } from 'react'
import { ASSESSMENT_QUESTION_COUNT } from '../data/assessmentQuestions'
import { resolveAssessmentStatus } from '../lib/assessmentClock'

export interface AssessmentStudentRow {
  id: string
  displayName: string
  /** Questions moved past — answered or timed out. */
  progress: number
  /** Real answers only. Shown next to the status so 8/10 never reads as 10/10. */
  answeredCount: number
  /** True once this student's CURRENT question has run out of time. Per student, not per room. */
  timedOut?: boolean
}

interface TeacherAssessmentStageProps {
  eyebrow: string
  title: string
  students: AssessmentStudentRow[]
  completedCount: number
  startedAt: number | null
  secondsPerQuestion: number
  /** Present only while the test has not been opened yet. */
  onStart?: () => void
  startLabel: string
  onContinue: () => void
  continueLabel: string
  continueHint: string
  busy: boolean
  footer: ReactNode
}

// Shared teacher control screen for the pre-test and post-test. Both stages have exactly the same
// shape — open the test, watch the shared clock and per-student progress, then move on — so they
// share one component and cannot drift apart.
//
// Deliberately NOT here: the Recall "เวลาต่อข้อ" control. Recall's per-item timing is a different
// mechanism on a different stage; showing it on an assessment screen invited the teacher to read
// it as the test's own timer. What is shown instead is the assessment's single total budget.
export const TeacherAssessmentStage = ({
  eyebrow,
  title,
  students,
  completedCount,
  startedAt,
  secondsPerQuestion,
  onStart,
  startLabel,
  onContinue,
  continueLabel,
  continueHint,
  busy,
  footer,
}: TeacherAssessmentStageProps) => {
  const notStarted = startedAt == null

  return (
    <section className="recall-command-view" aria-live="polite">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="recall-command-title">{title}</h2>

      {/* The test's own total budget, stated plainly — before it opens as a plan, after it opens
          as a live countdown. */}
      {/* Per-question time, not a room-wide countdown: students work at their own pace, so there
          is no single shared clock to display. Per-student progress is in the list below. */}
      <p className="assessment-stage-budget">
        เวลาต่อข้อ {secondsPerQuestion} วินาที
        {notStarted ? null : <span className="assessment-stage-live"> • กำลังทำแบบทดสอบ</span>}
      </p>

      <p className="recall-command-count">
        เสร็จแล้ว {completedCount} / {students.length} คน
      </p>
      <div
        className="recall-command-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={students.length}
        aria-valuenow={completedCount}
      >
        <i style={{ width: `${students.length > 0 ? (completedCount / students.length) * 100 : 0}%` }} />
      </div>

      {/* Counts and status only — never any answer content, so a projected teacher screen cannot
          leak the test itself. */}
      <ul className="recall-player-chips" aria-label="สถานะรายบุคคล">
        {students.map((student) => {
          const status = resolveAssessmentStatus(student.progress, student.timedOut ?? false, student.answeredCount)
          return (
            <li
              key={student.id}
              className={`recall-player-chip ${status === 'เสร็จแล้ว' ? 'recall-player-chip-done' : ''} ${status === 'หมดเวลา' ? 'recall-player-chip-timeout' : ''}`}
            >
              <span>{student.displayName}</span>
              <b>{student.answeredCount}/{ASSESSMENT_QUESTION_COUNT}</b>
              <span>{status}</span>
            </li>
          )
        })}
      </ul>

      {notStarted && onStart ? (
        <>
          {/* Until this is pressed the test is closed: students are on a waiting screen and every
              answer write is rejected server-side. */}
          <button type="button" className="primary-button recall-start-main-button mt-5" onClick={onStart} disabled={busy}>
            {busy ? 'กำลังดำเนินการ...' : startLabel}
          </button>
          <p className="recall-command-hint">นักเรียนจะยังเริ่มทำไม่ได้จนกว่าจะกดปุ่มนี้</p>
        </>
      ) : (
        <>
          {/* Always available — one unfinished student must never hold the class. */}
          <button type="button" className="primary-button recall-start-main-button mt-5" onClick={onContinue} disabled={busy}>
            {busy ? 'กำลังดำเนินการ...' : continueLabel}
          </button>
          {completedCount < students.length ? <p className="recall-command-hint">{continueHint}</p> : null}
        </>
      )}

      {footer}
    </section>
  )
}
