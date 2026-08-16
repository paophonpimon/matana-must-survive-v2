import { useCallback, useEffect, useRef, useState } from 'react'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { friendlyError } from '../services'
import { clearRecallTimerMark, readRecallTimerMark, writeRecallTimerMark } from '../services/sessionStorage'
import type { RecallAnswerInput } from '../services/gameService'
import { RECALL_TIMEOUT_CHOICE_ID, type Player } from '../types/game'

interface RecallPhaseProps {
  player: Player
  // Scopes the persisted countdown anchor so timing from one room never leaks into another.
  roomCode: string
  // Teacher-configured seconds per item, read from the room so every student counts down from
  // the same value — no hardcoded duration lives in this component anymore.
  secondsPerItem: number
  onAnswer: (input: RecallAnswerInput) => Promise<void>
}

// "กู้ความทรงจำมัทนา" (Story Recall) — the mandatory individual phase that runs BEFORE any team
// exists. Deliberately self-contained: no team/magic/competition UI at all, matching the spec's
// "no competitive points, no team-score impact, no magic, no speed scoring."
//
// Progress is entirely individual and player-paced (unlike Main/Boss, which are room-synchronized
// by a shared currentQuestionIndex/timer) — the source of truth for "how far along" is simply
// player.recallAnswers.length. `viewedIndex` is local UI state, not game state: it lets a student
// see feedback for the question they just answered before moving on, without the view jumping
// straight to the next question the instant the write lands. It's seeded ONCE from the server's
// real progress on first load (so a mid-recall refresh resumes at the right question, not question
// 1) and only ever advances afterward via the student's own explicit "ข้อต่อไป" tap.
//
// The countdown is deliberately client-side and per-item: Recall has no room-level timer to
// synchronize against (every student is on their own question at their own moment), and the timer
// is a pacing device only — it can never touch competitive scoring, since Recall writes only ever
// reach player.recallAnswers. A refresh restarts the current item's countdown, which is
// acceptable precisely because nothing competitive rides on it.
export const RecallPhase = ({ player, roomCode, secondsPerItem, onAnswer }: RecallPhaseProps) => {
  const [viewedIndex, setViewedIndex] = useState(0)
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    setViewedIndex(player.recallAnswers.length)
  }, [player.recallAnswers.length])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(secondsPerItem)

  const totalCount = RECALL_QUESTIONS.length
  const currentQuestion = RECALL_QUESTIONS[viewedIndex]
  const answeredRecord = currentQuestion
    ? player.recallAnswers.find((entry) => entry.conceptId === currentQuestion.id)
    : undefined
  const timedOut = answeredRecord?.selectedChoiceId === RECALL_TIMEOUT_CHOICE_ID

  const submit = useCallback(async (choiceId: string): Promise<void> => {
    if (!currentQuestion) return
    setBusy(true)
    setError('')
    try {
      await onAnswer({ conceptId: currentQuestion.id, selectedChoiceId: choiceId, expectedRecallIndex: viewedIndex })
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }, [currentQuestion, onAnswer, viewedIndex])

  const submitChoice = (choiceId: string): void => {
    if (answeredRecord || busy) return
    void submit(choiceId)
  }

  // One countdown per item: freezes once the item is answered, and on expiry persists the item as
  // unanswered (RECALL_TIMEOUT_CHOICE_ID -> isCorrect false) so the before-play evidence counts it,
  // then reveals the correct answer like any other item.
  //
  // The countdown is anchored to a persisted start time rather than to mount time, so a refresh
  // resumes the remaining seconds instead of granting a fresh full duration. A genuinely new
  // question (or round) doesn't match the stored mark and therefore gets a fresh anchor; a question
  // whose time already ran out while the page was away resolves to 0 remaining on the first pass
  // and is submitted as a timeout immediately, so expired stays expired.
  const expiredRef = useRef('')
  useEffect(() => {
    if (!currentQuestion) return
    if (answeredRecord) return

    const storedMark = readRecallTimerMark(roomCode, player.id)
    const resumes = storedMark?.round === player.currentRound && storedMark.conceptId === currentQuestion.id
    const startedAt = resumes ? storedMark.startedAt : Date.now()
    if (!resumes) {
      writeRecallTimerMark(roomCode, player.id, { round: player.currentRound, conceptId: currentQuestion.id, startedAt })
    }

    const remainingAt = (): number => Math.max(0, secondsPerItem - Math.floor((Date.now() - startedAt) / 1_000))
    const expire = (): void => {
      // Guard against a double-submit if this effect re-runs while the write is still in flight.
      if (expiredRef.current === currentQuestion.id) return
      expiredRef.current = currentQuestion.id
      void submit(RECALL_TIMEOUT_CHOICE_ID)
    }

    const initialRemaining = remainingAt()
    setSecondsLeft(initialRemaining)
    if (initialRemaining <= 0) {
      expire()
      return
    }

    const intervalId = window.setInterval(() => {
      const remaining = remainingAt()
      setSecondsLeft(remaining)
      if (remaining > 0) return
      window.clearInterval(intervalId)
      expire()
    }, 250)
    return () => window.clearInterval(intervalId)
  }, [currentQuestion, answeredRecord, submit, secondsPerItem, roomCode, player.id, player.currentRound])

  if (!currentQuestion) {
    // All five items are done, so the anchor has nothing left to resume — drop it rather than
    // leaving a stale mark sitting in this tab's storage.
    clearRecallTimerMark(roomCode, player.id)
    // Dedicated waiting screen — deliberately distinct from LobbyPage's own waiting copy, since
    // this student has already finished Recall and is waiting on classmates, not on the room to
    // open. The student is never auto-advanced into team setup: the teacher drives that.
    return (
      <div className="recall-phase recall-phase-complete" aria-live="polite">
        <div className="waiting-rings mx-auto" aria-hidden="true"><span /><i>ม</i></div>
        <h1 className="mt-6 text-center text-2xl font-semibold sm:text-3xl">ทบทวนเรื่องราวครบแล้ว</h1>
        <p className="recall-phase-complete-status">รอเพื่อนร่วมภารกิจ</p>
        <p className="mx-auto mt-3 max-w-md text-center text-[#d8d1c5]">เมื่อทุกคนทำครบ ครูจะพาไปจัดทีมและเตรียมเข้าสู่เกม</p>
      </div>
    )
  }

  const urgent = !answeredRecord && secondsLeft <= 5

  return (
    <div className="recall-phase">
      <header className="recall-phase-header">
        <p className="eyebrow">ทบทวนเรื่องราวมัทนา</p>
        <p className="recall-phase-note">รายบุคคล • ไม่มีผลต่อคะแนนการแข่งขัน</p>
      </header>

      <div className="recall-status-bar">
        <span className="recall-step-count">ข้อที่ {viewedIndex + 1} จาก {totalCount}</span>
        {/* 5-step progression: one pip per item, so "where am I in the set" is readable at a
            glance rather than inferred from a continuous bar. */}
        <ol className="recall-step-pips" aria-label={`ความคืบหน้า ${viewedIndex + 1} จาก ${totalCount}`}>
          {RECALL_QUESTIONS.map((question, index) => (
            <li
              key={question.id}
              className={index < viewedIndex || (index === viewedIndex && answeredRecord) ? 'recall-step-done' : index === viewedIndex ? 'recall-step-current' : ''}
            />
          ))}
        </ol>
        <span className={`recall-countdown ${urgent ? 'recall-countdown-urgent' : ''} ${answeredRecord ? 'recall-countdown-done' : ''}`} aria-live="off">
          {answeredRecord ? '—' : `${secondsLeft}`}
          <small>วินาที</small>
        </span>
      </div>

      <section className={`recall-question-card ${answeredRecord ? 'answer-saved' : ''}`}>
        <p className="recall-question-label">{currentQuestion.label}</p>
        <h1 className="recall-question-prompt">{currentQuestion.prompt}</h1>
        <div className="recall-choice-grid">
          {currentQuestion.choices.map((choice, index) => {
            const isSelected = answeredRecord?.selectedChoiceId === choice.id
            const isCorrectChoice = choice.id === currentQuestion.correctChoiceId
            const resultClass = answeredRecord
              ? isCorrectChoice ? 'choice-result-correct' : isSelected ? 'choice-result-wrong' : ''
              : ''
            return (
              <button
                key={choice.id}
                type="button"
                className={`choice-button recall-choice-button ${isSelected ? 'choice-selected' : ''} ${resultClass}`}
                onClick={() => submitChoice(choice.id)}
                disabled={busy || Boolean(answeredRecord)}
              >
                <span>{['ก', 'ข'][index]}</span><strong>{choice.text}</strong>
              </button>
            )
          })}
        </div>

        <div className="feedback-region mt-5" aria-live="assertive">
          {error ? <p className="error-message">{error}</p> : busy ? (
            <p>กำลังบันทึกคำตอบ...</p>
          ) : answeredRecord ? (
            <div className={answeredRecord.isCorrect ? 'answer-result-correct' : 'answer-result-wrong'}>
              <strong>{answeredRecord.isCorrect ? '✓ ตอบถูก' : timedOut ? '⏳ หมดเวลา — ยังไม่ได้ตอบ' : '✕ ตอบผิด'}</strong>
              <p className="recall-feedback-text">{currentQuestion.feedback}</p>
            </div>
          ) : null}
        </div>

        {answeredRecord ? (
          <button
            type="button"
            className="primary-button recall-next-button"
            onClick={() => setViewedIndex((current) => current + 1)}
          >
            {viewedIndex + 1 >= totalCount ? 'เสร็จสิ้น' : 'ข้อต่อไป'}
          </button>
        ) : null}
      </section>

      <p className="recall-phase-footnote">ตอบได้เพียงครั้งเดียวต่อข้อ • ข้อละ {secondsPerItem} วินาที • ไม่มีผลต่อคะแนนทีมหรือมนตรา</p>
    </div>
  )
}
