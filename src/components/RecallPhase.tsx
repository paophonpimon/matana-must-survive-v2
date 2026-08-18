import { useEffect, useMemo, useRef, useState } from 'react'
import { shuffleChoicesForPlayer } from '../lib/choiceOrder'
import { RECALL_QUESTIONS } from '../data/recallQuestions'
import { getRemainingMilliseconds, recallQuestionTiming } from '../lib/gameFlow'
import { friendlyError } from '../services'
import type { RecallAnswerInput } from '../services/gameService'
import { RECALL_QUESTION_COUNT, type Player, type Room } from '../types/game'

interface RecallPhaseProps {
  player: Player
  room: Room
  onAnswer: (input: RecallAnswerInput) => Promise<void>
}

// "ทบทวนเรื่องราวมัทนา" (Story Recall) — the mandatory individual phase that runs BEFORE any team
// exists. Deliberately self-contained: no team/magic/competition UI at all, matching the spec's
// "no competitive points, no team-score impact, no magic, no speed scoring."
//
// Recall is ROOM-SYNCHRONIZED, exactly like Main: room.recallQuestionIndex and
// room.recallQuestionStartedAt are the single source of truth for which item is live and how long
// is left, so every student sees the same question at the same moment. Nothing here derives
// progress from the student's own recallAnswers, and there is no "next question" button — the
// room's timeline advances everyone together.
//
// Answering early locks that student's answer and reveals feedback, but never advances them ahead
// of the room. Not answering in time simply leaves the concept unanswered (absence already counts
// as not-correct in the learning evidence), and never holds anyone up.
export const RecallPhase = ({ player, room, onAnswer }: RecallPhaseProps) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())

  const totalCount = RECALL_QUESTION_COUNT
  const questionIndex = room.recallQuestionIndex
  const currentQuestion = RECALL_QUESTIONS[questionIndex]
  // Per-student choice order, derived from (playerId, conceptId). Correctness below still
  // compares choice.id, so a different order per student changes nothing about scoring.
  // Declared above the early return so the hook order is identical on every render.
  const orderedChoices = useMemo(
    () => shuffleChoicesForPlayer(currentQuestion?.choices ?? [], player.id, currentQuestion?.id ?? ''),
    [currentQuestion, player.id],
  )

  const answeredRecord = currentQuestion
    ? player.recallAnswers.find((entry) => entry.conceptId === currentQuestion.id)
    : undefined

  // Same timing helpers Main uses, fed a recall-shaped timing object.
  const recallTiming = recallQuestionTiming(room)
  const remainingMs = currentQuestion ? getRemainingMilliseconds(recallTiming, now) : 0
  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1_000))
  const timeExpired = remainingMs <= 0

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(intervalId)
  }, [])

  // Clear any transient error/busy state when the room moves to a new question, so a failure on
  // one item never bleeds into the next.
  const lastIndexRef = useRef(questionIndex)
  useEffect(() => {
    if (lastIndexRef.current === questionIndex) return
    lastIndexRef.current = questionIndex
    setError('')
    setBusy(false)
  }, [questionIndex])

  const submitChoice = async (choiceId: string): Promise<void> => {
    if (!currentQuestion || answeredRecord || busy || timeExpired) return
    setBusy(true)
    setError('')
    try {
      await onAnswer({ conceptId: currentQuestion.id, selectedChoiceId: choiceId, expectedRecallIndex: questionIndex })
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!currentQuestion) {
    // The shared sequence has finished all 5 items. Everyone lands here together; the teacher
    // drives the move into team setup from their own screen.
    return (
      <div className="recall-phase recall-phase-complete" aria-live="polite">
        <div className="waiting-rings mx-auto" aria-hidden="true"><span /><i>ม</i></div>
        <h1 className="mt-6 text-center text-2xl font-semibold sm:text-3xl">ทบทวนเรื่องราวครบแล้ว</h1>
        <p className="recall-phase-complete-status">รอเพื่อนร่วมภารกิจ</p>
        <p className="mx-auto mt-3 max-w-md text-center text-[#d8d1c5]">เมื่อทุกคนพร้อม ครูจะพาไปจัดทีมและเตรียมเข้าสู่เกม</p>
      </div>
    )
  }

  const urgent = !answeredRecord && !timeExpired && secondsLeft <= 5
  // Once the countdown expires the answer is revealed to everyone, answered or not.
  const revealing = timeExpired || Boolean(answeredRecord)


  return (
    <div className="recall-phase">
      <header className="recall-phase-header">
        <p className="eyebrow">ทบทวนเรื่องราวมัทนา</p>
        <p className="recall-phase-note">รายบุคคล • ไม่มีผลต่อคะแนนการแข่งขัน</p>
      </header>

      <div className="recall-status-bar">
        <span className="recall-step-count">ข้อที่ {questionIndex + 1} จาก {totalCount}</span>
        {/* One pip per item, driven by the room's shared index. */}
        <ol className="recall-step-pips" aria-label={`ความคืบหน้า ${questionIndex + 1} จาก ${totalCount}`}>
          {RECALL_QUESTIONS.map((question, index) => (
            <li
              key={question.id}
              className={index < questionIndex ? 'recall-step-done' : index === questionIndex ? 'recall-step-current' : ''}
            />
          ))}
        </ol>
        <span className={`recall-countdown ${urgent ? 'recall-countdown-urgent' : ''} ${timeExpired ? 'recall-countdown-done' : ''}`} aria-live="off">
          {timeExpired ? '—' : `${secondsLeft}`}
          <small>วินาที</small>
        </span>
      </div>

      <section className={`recall-question-card ${answeredRecord ? 'answer-saved' : ''}`}>
        <p className="recall-question-label">{currentQuestion.label}</p>
        <h1 className="recall-question-prompt">{currentQuestion.prompt}</h1>
        <div className="recall-choice-grid">
          {orderedChoices.map((choice, index) => {
            const isSelected = answeredRecord?.selectedChoiceId === choice.id
            const isCorrectChoice = choice.id === currentQuestion.correctChoiceId
            const resultClass = revealing
              ? isCorrectChoice ? 'choice-result-correct' : isSelected ? 'choice-result-wrong' : ''
              : ''
            return (
              <button
                key={choice.id}
                type="button"
                className={`choice-button recall-choice-button ${isSelected ? 'choice-selected' : ''} ${resultClass}`}
                onClick={() => void submitChoice(choice.id)}
                disabled={busy || Boolean(answeredRecord) || timeExpired}
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
              <strong>{answeredRecord.isCorrect ? '✓ ตอบถูก' : '✕ ตอบผิด'}</strong>
              <p className="recall-feedback-text">{currentQuestion.feedback}</p>
              {!timeExpired ? <small className="recall-waiting-note">รอเพื่อน ๆ แล้วไปข้อต่อไปพร้อมกัน</small> : null}
            </div>
          ) : timeExpired ? (
            <div className="answer-result-missed">
              <strong>หมดเวลา — ยังไม่ได้ตอบ</strong>
              <p className="recall-feedback-text">{currentQuestion.feedback}</p>
            </div>
          ) : null}
        </div>
      </section>

      <p className="recall-phase-footnote">ตอบได้เพียงครั้งเดียวต่อข้อ • ข้อละ {room.recallQuestionDurationSeconds} วินาที • ทุกคนเปลี่ยนข้อพร้อมกัน</p>
    </div>
  )
}
