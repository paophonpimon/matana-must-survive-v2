import { useState } from 'react'
import { ASSESSMENT_QUESTION_COUNT, POST_TEST_QUESTIONS } from '../data/assessmentQuestions'
import { friendlyError } from '../services'
import type { PostTestAnswerInput } from '../services/gameService'
import type { Player } from '../types/game'

interface PostTestPhaseProps {
  player: Player
  onAnswer: (input: PostTestAnswerInput) => Promise<void>
}

// "แบบทดสอบหลังเรียน" (Post-test) — an individual, self-paced ASSESSMENT, not a game round.
//
// Deliberately absent, and each for a reason:
//   - no timer: the pre-test measures knowledge, not speed
//   - no correctness feedback, no explanation, no reveal: showing the answer here would teach the
//     item and contaminate the post-test comparison this test exists to support
//   - no running score: a visible score turns a measurement into a competition
//   - no team / magic / boss / ranking anything: this phase has no competitive concepts at all
//
// Progress is INDIVIDUAL and derived from the student's own saved answers — unlike Recall, which
// is room-synchronized. player.postTestAnswers.length IS the current question index, so a refresh,
// a reconnect or a device swap resumes at exactly the right item with no extra state to restore.
//
// This runs after Main has finished, so player.submitted is already true and the Main score is
// final. Nothing here reads or writes either.
//
// The component never renders `correctChoiceId`, and never branches on it.
export const PostTestPhase = ({ player, onAnswer }: PostTestPhaseProps) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The student's own saved count is the resume point and the progress indicator, both.
  const answeredCount = player.postTestAnswers.length
  const finished = answeredCount >= ASSESSMENT_QUESTION_COUNT
  const currentQuestion = POST_TEST_QUESTIONS[answeredCount]

  const submit = async (selectedChoiceId: string): Promise<void> => {
    if (busy || !currentQuestion) return
    setBusy(true)
    setError('')
    try {
      // The service validates order/duplication/bounds and derives correctness from the bank.
      // Advancing happens implicitly: the saved answer grows postTestAnswers, which moves the
      // index above. There is no local "next question" state to drift out of sync.
      await onAnswer({
        questionId: currentQuestion.id,
        selectedChoiceId,
        expectedIndex: answeredCount,
      })
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  if (finished) {
    return (
      <section className="glass-panel w-full p-6 text-center sm:p-8" aria-live="polite">
        <p className="eyebrow">แบบทดสอบหลังเรียน</p>
        <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">ทำแบบทดสอบหลังเรียนครบแล้ว</h1>
        <div className="waiting-banner mt-6">
          <span className="pulse-dot" aria-hidden="true" />
          <span>
            <strong>รอครูสรุปกิจกรรม</strong>
            <small>หน้านี้จะเปลี่ยนให้อัตโนมัติเมื่อครูสรุปผลกิจกรรม</small>
          </span>
        </div>
      </section>
    )
  }

  return (
    <section className="glass-panel w-full p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow">แบบทดสอบหลังเรียน</p>
        <span className="count-badge">ข้อ {answeredCount + 1} / {ASSESSMENT_QUESTION_COUNT}</span>
      </div>

      <h1 className="mt-4 text-xl font-semibold leading-relaxed sm:text-2xl">{currentQuestion?.question}</h1>

      <div className="mt-6 grid gap-3">
        {currentQuestion?.choices.map((choice) => (
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
        ตอบตามความเข้าใจของตนเอง แบบทดสอบนี้ไม่มีการจับเวลาและไม่มีผลต่อคะแนนเกม
      </p>
    </section>
  )
}
