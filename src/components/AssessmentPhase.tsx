import { useMemo, useState } from 'react'
import { ASSESSMENT_QUESTION_COUNT } from '../data/assessmentQuestions'
import type { AssessmentWindow } from '../lib/gameFlow'
import { shuffleChoicesForPlayer } from '../lib/choiceOrder'
import { friendlyError } from '../services'
import { useAssessmentClock } from '../hooks/useAssessmentClock'
import { AssessmentTimer } from './AssessmentTimer'
import type { AssessmentQuestion } from '../data/assessmentQuestions'

export interface AssessmentPhaseProps {
  /** Seeds this student's own choice order. Never affects correctness, which is id-based. */
  playerId: string
  /** The student's own saved answers for THIS test — its length is the resume point. */
  answers: Array<{ questionId: string; answeredAt: number }>
  bank: readonly AssessmentQuestion[]
  /** Null until the teacher opens the test. Authoritative, persisted on the room. */
  startedAt: number | null
  /** This student's CURRENT question window, built by gameFlow's pre/postTestWindow. */
  questionWindow: AssessmentWindow
  eyebrow: string
  waitingTitle: string
  waitingHint: string
  finishedTitle: string
  finishedHint: string
  onAnswer: (input: { questionId: string; selectedChoiceId: string; expectedIndex: number }) => Promise<void>
}

// Shared body of the pre-test and post-test screens. The two differ only in their approved bank
// and their copy — the gating, the timer and the answer flow are identical by construction, so
// neither half of the comparison can drift from the other.
//
// Deliberately absent, each for a reason:
//   - no per-question timer: there is ONE budget for the whole test, so no item is speed-scored
//   - no correctness feedback, explanation or reveal: that would teach the item and contaminate
//     the pre/post comparison this test exists to support
//   - no running score: a visible score turns a measurement into a competition
//   - no team / magic / boss / ranking anything
//
// Three states, all derived from room state rather than from local progress:
//   startedAt == null  -> waiting; the teacher has not opened the test
//   open               -> answering, with the shared countdown
//   expired / complete -> locked; saved answers stay, nothing is fabricated
export const AssessmentPhase = ({
  playerId,
  answers,
  bank,
  startedAt,
  questionWindow,
  eyebrow,
  waitingTitle,
  waitingHint,
  finishedTitle,
  finishedHint,
  onAnswer,
}: AssessmentPhaseProps) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Per-question clock. The window restarts for each item — question 1 from the instant the
  // teacher opened the test, every later one from the previous answer's answeredAt — so moving on
  // resets the countdown to the full configured value with nothing stored per question.
  const clock = useAssessmentClock(questionWindow)

  const answeredCount = answers.length
  const finished = answeredCount >= ASSESSMENT_QUESTION_COUNT
  const currentQuestion = bank[answeredCount]
  // Per-student order, derived from (playerId, questionId) — stable across rerender, refresh and
  // reconnect, and never reshuffled once an answer is chosen because nothing here is random at
  // render time.
  const orderedChoices = useMemo(
    () => (currentQuestion ? shuffleChoicesForPlayer(currentQuestion.choices, playerId, currentQuestion.id) : []),
    [currentQuestion, playerId],
  )

  const submit = async (selectedChoiceId: string): Promise<void> => {
    if (busy || !currentQuestion || !clock.open) return
    setBusy(true)
    setError('')
    try {
      // The service re-checks the open/expired gates and the ordering, and derives correctness
      // from the bank. Advancing happens implicitly: the saved answer grows the array, which moves
      // the index above — there is no local "next question" state to drift out of sync.
      await onAnswer({ questionId: currentQuestion.id, selectedChoiceId, expectedIndex: answeredCount })
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  // 1. Not open yet. The student sees a waiting screen and literally has no question to answer —
  //    this is the gate, not a disabled button they could work around.
  if (startedAt == null) {
    return (
      <section className="glass-panel w-full p-6 text-center sm:p-8" aria-live="polite">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">{waitingTitle}</h1>
        <div className="waiting-banner mt-6">
          <span className="pulse-dot" aria-hidden="true" />
          <span>
            <strong>{waitingHint}</strong>
            <small>หน้านี้จะเปลี่ยนให้อัตโนมัติเมื่อครูเริ่มแบบทดสอบ</small>
          </span>
        </div>
      </section>
    )
  }

  // 2. Done, or the budget ran out. Both land here; the message differs so a student who ran out
  //    of time is told so plainly rather than being shown a silent dead end.
  if (finished || clock.expired) {
    return (
      <section className="glass-panel w-full p-6 text-center sm:p-8" aria-live="polite">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
          {finished ? finishedTitle : 'หมดเวลาข้อนี้'}
        </h1>
        {!finished ? (
          <p className="mt-3 text-sm text-[#d8d1c5]">
            คำตอบที่ทำไว้ {answeredCount} จาก {ASSESSMENT_QUESTION_COUNT} ข้อ ถูกบันทึกไว้เรียบร้อยแล้ว
          </p>
        ) : null}
        <div className="waiting-banner mt-6">
          <span className="pulse-dot" aria-hidden="true" />
          <span>
            <strong>{finishedHint}</strong>
            <small>หน้านี้จะเปลี่ยนให้อัตโนมัติเมื่อครูเริ่มกิจกรรมถัดไป</small>
          </span>
        </div>
      </section>
    )
  }

  // 3. Open and unfinished — the only state that renders a question.
  return (
    <section className="glass-panel w-full p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">{eyebrow}</p>
        <div className="flex items-center gap-3">
          <span className="count-badge">ข้อ {answeredCount + 1} / {ASSESSMENT_QUESTION_COUNT}</span>
          <AssessmentTimer state={clock} />
        </div>
      </div>

      {clock.warning ? (
        <p className="assessment-warning mt-3" role="status">เหลือเวลาไม่ถึง 30 วินาที — ตอบข้อที่ทำได้ก่อน</p>
      ) : null}

      <h1 className="mt-4 text-xl font-semibold leading-relaxed sm:text-2xl">{currentQuestion?.question}</h1>

      <div className="mt-6 grid gap-3">
        {orderedChoices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="choice-button"
            onClick={() => void submit(choice.id)}
            disabled={busy}
          >
            {choice.text}
          </button>
        ))}
      </div>

      {error ? <p className="error-message mt-5" role="alert">{error}</p> : null}

      <p className="mt-5 text-sm text-[#bdb5ac]">
        ตอบตามความเข้าใจของตนเอง • แต่ละข้อมีเวลาเท่ากัน • ไม่มีคะแนนความเร็วและไม่มีผลต่อคะแนนเกม
      </p>
    </section>
  )
}
