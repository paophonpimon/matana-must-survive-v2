import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { LoadingPanel, ScenePage } from '../components/Layout'
import { PostTestPhase } from '../components/PostTestPhase'
import { PreTestPhase } from '../components/PreTestPhase'
import { RecallPhase } from '../components/RecallPhase'
import { SurveyPhase } from '../components/SurveyPhase'
import { useGame } from '../context/GameContext'
import { questionsById } from '../data/questions'
import { usePlayer, useRoom, useTeamMagic } from '../hooks/useGameData'
import { shuffleChoicesForPlayer } from '../lib/choiceOrder'
import { areAnswersLocked, getRemainingMilliseconds, mainQuestionTiming } from '../lib/gameFlow'
import { friendlyError } from '../services'
import { PRESENTATION_DEMO_PARTICIPANT_ID, PRESENTATION_DEMO_ROOM_CODE } from '../services/demoService'

// The judge / visitor experience. It is NOT a second game: it renders the real presentation-demo
// room through the same GameService subscriptions, question bank, answer-locking rules and
// student components the production /game screen uses. The one interactive showcase is a live
// Main question — every other phase shows a polished phase-aware message or reuses the existing
// self-paced phase component, because the presenter's fast-forward stays authoritative for those.
//
// Identity is the seeded student D01 (PRESENTATION_DEMO_PARTICIPANT_ID) — no login, no room code,
// no QR, no Firebase auth, no production session. The service enforces every rule; this page adds
// no ability the service does not already grant a real student.

const PARTICIPANT_NAME = 'ผู้ทดลอง'

const CATEGORY_LABELS: Record<string, string> = {
  basic: 'พื้นฐานเรื่อง',
  characters: 'ตัวละคร',
  plot: 'เนื้อเรื่อง',
  poetry: 'วรรณศิลป์',
  theme: 'แก่นเรื่อง',
}

const formatCountdown = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const PhaseNotice = ({ title, detail }: { title: string; detail?: ReactNode }) => (
  <div className="demo-student-notice glass-panel mx-auto my-auto w-full max-w-xl p-8 text-center" aria-live="polite">
    <div className="mystic-loader mx-auto" aria-hidden="true" />
    <h1 className="mt-5 text-xl font-semibold text-[#fff7df]">{title}</h1>
    {detail ? <p className="mt-3 text-[#d8d1c5]">{detail}</p> : null}
  </div>
)

const Shell = ({ children }: { children: ReactNode }) => (
  <ScenePage compact className="demo-student-page">
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-4 sm:px-7">
      <p className="demo-student-tag" role="status">โหมดสาธิต — ข้อมูลจำลอง · มุมมองนักเรียน ({PARTICIPANT_NAME})</p>
      {children}
    </div>
  </ScenePage>
)

export const DemoStudentPage = () => {
  const { service } = useGame()
  const code = PRESENTATION_DEMO_ROOM_CODE
  const participantId = PRESENTATION_DEMO_PARTICIPANT_ID
  const roomState = useRoom(code)
  const playerState = usePlayer(code, participantId)
  const room = roomState.data
  const player = playerState.data
  const teamId = player?.teamId ?? ''
  const magicState = useTeamMagic(code, teamId)

  const [now, setNow] = useState(Date.now())
  const [saving, setSaving] = useState(false)
  const [pendingChoiceId, setPendingChoiceId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(intervalId)
  }, [])

  const questionIndex = room?.currentQuestionIndex ?? 0
  const questionId = room?.questionIds[questionIndex]
  const question = questionId ? questionsById.get(questionId) : undefined
  const savedAnswer = player?.answers.find((answer) => answer.questionId === questionId)
  const selectedChoiceId = pendingChoiceId || savedAnswer?.selectedChoiceId || ''

  // A fresh question (or a presenter reset that changes the phase) clears any local pending state.
  useEffect(() => {
    setPendingChoiceId('')
    setError('')
    setSaving(false)
  }, [questionId, room?.phase, room?.status])

  const timing = room ? mainQuestionTiming(room) : null
  const remainingMs = timing ? getRemainingMilliseconds(timing, now) : 0
  const timeExpired = !timing || remainingMs <= 0
  // Correctness is shown only after the answer window closes — the same rule the production
  // student screen and the teacher screen both honour, so the demo cannot leak an answer early.
  const revealed = timeExpired
  const answerWasCorrect = Boolean(selectedChoiceId && selectedChoiceId === question?.correctChoiceId)

  const queuedEffect = magicState.data?.queuedEffect
  const illusionHiddenChoiceIds = useMemo(
    () => (queuedEffect?.itemType === 'illusion' && queuedEffect.affectedQuestionIndex === questionIndex
      ? queuedEffect.hiddenChoiceIds ?? []
      : []),
    [queuedEffect, questionIndex],
  )
  const surgeOnThisQuestion = Boolean(
    queuedEffect?.itemType === 'power_surge'
    && queuedEffect.affectedQuestionIndex === questionIndex
    && queuedEffect.targetTeamId === player?.teamId,
  )
  const visibleChoices = useMemo(
    () => shuffleChoicesForPlayer(
      question ? question.choices.filter((choice) => !illusionHiddenChoiceIds.includes(choice.id)) : [],
      participantId,
      question?.id ?? '',
    ),
    [question, illusionHiddenChoiceIds, participantId],
  )

  const answerQuestion = async (choiceId: string): Promise<void> => {
    if (!room || !player || !question || areAnswersLocked(saving, timeExpired) || selectedChoiceId === choiceId) return
    setSaving(true)
    setError('')
    setPendingChoiceId(choiceId)
    try {
      await service.saveAnswer(code, participantId, {
        questionId: question.id,
        selectedChoiceId: choiceId,
        expectedQuestionIndex: questionIndex,
      })
    } catch (reason) {
      setError(friendlyError(reason))
      setPendingChoiceId('')
    } finally {
      setSaving(false)
    }
  }

  if (roomState.loading || playerState.loading) {
    return <Shell><LoadingPanel text="กำลังเชื่อมต่อกับการสาธิต..." /></Shell>
  }

  if (!room || !player) {
    return (
      <Shell>
        <PhaseNotice
          title="ยังไม่มีการสาธิตที่กำลังดำเนิน"
          detail="ให้ผู้นำเสนอเปิดหน้าผู้นำเสนอและเริ่มการสาธิตก่อน หน้านี้จะอัปเดตเองเมื่อเริ่มแล้ว"
        />
      </Shell>
    )
  }

  if (room.status === 'completed' || room.status === 'closed') {
    return (
      <Shell>
        <PhaseNotice
          title="การสาธิตจบแล้ว"
          detail="ดูผลสรุปการเรียนรู้และหลักฐานได้ที่หน้าผู้นำเสนอ"
        />
      </Shell>
    )
  }

  if (room.phase === 'survey') {
    return (
      <Shell>
        <SurveyPhase player={player} onRespond={(input) => service.saveSurveyResponse(code, participantId, input)} />
      </Shell>
    )
  }

  if (room.phase === 'postTest') {
    return (
      <Shell>
        <PostTestPhase
          player={player}
          room={room}
          onAnswer={(input) => service.savePostTestAnswer(code, participantId, input)}
          onTimeout={(expectedIndex) => service.advancePostTestQuestion(code, participantId, expectedIndex)}
        />
      </Shell>
    )
  }

  if (room.phase === 'preTest') {
    return (
      <Shell>
        <PreTestPhase
          player={player}
          room={room}
          onAnswer={(input) => service.savePreTestAnswer(code, participantId, input)}
          onTimeout={(expectedIndex) => service.advancePreTestQuestion(code, participantId, expectedIndex)}
        />
      </Shell>
    )
  }

  if (room.phase === 'recall') {
    return (
      <Shell>
        <RecallPhase player={player} room={room} onAnswer={(input) => service.saveRecallAnswer(code, participantId, input)} />
      </Shell>
    )
  }

  if (room.phase === 'boss') {
    return (
      <Shell>
        <PhaseNotice
          title={room.bossAwaitingContinue ? 'ศึกด่านชิงมนตราจบแล้ว' : 'ผู้นำเสนอกำลังดำเนินด่านชิงมนตรา'}
          detail={room.bossAwaitingContinue
            ? 'รอผู้นำเสนอกด "เล่นต่อ" เพื่อกลับสู่ภารกิจหลัก'
            : 'ด่านชิงมนตราดำเนินโดยผู้นำเสนอในการสาธิตนี้ หน้านี้จะกลับมารับคำถามหลักเมื่อถึงข้อถัดไป'}
        />
      </Shell>
    )
  }

  if (room.phase !== 'main' || room.status !== 'playing') {
    return (
      <Shell>
        <PhaseNotice
          title={room.phase === 'teamSetup' ? 'กำลังจัดทีม' : 'รอผู้นำเสนอเริ่มกิจกรรม'}
          detail={room.phase === 'teamSetup'
            ? 'ผู้นำเสนอกำลังจัดทีมและตั้งชื่อทีม เมื่อเข้าสู่คำถามหลัก คุณจะได้ลองตอบหนึ่งข้อผ่านหน้าจอนักเรียนจริง'
            : 'เมื่อผู้นำเสนอเข้าสู่คำถามหลัก คุณจะได้ลองตอบหนึ่งข้อผ่านหน้าจอนักเรียนจริง'}
        />
      </Shell>
    )
  }

  if (!question) {
    return (
      <Shell>
        <PhaseNotice title="กำลังเตรียมคำถามข้อถัดไป" />
      </Shell>
    )
  }

  const categoryLabel = CATEGORY_LABELS[question.category] ?? ''

  return (
    <Shell>
      <header className="game-header">
        <div className="min-w-0">
          <p className="text-xs text-[#aaa298]">ผู้เล่น (จำลอง)</p>
          <strong className="block truncate text-[#fff7df]">{player.displayName}</strong>
        </div>
        <div className="text-right">
          <p className="text-xs text-[#aaa298]">คำถามที่ {Math.min(questionIndex + 1, 10)} / 10</p>
          <strong className={`question-timer ${remainingMs <= 5_000 ? 'question-timer-urgent' : ''}`}>
            {timeExpired ? 'หมดเวลา' : formatCountdown(remainingMs)}
          </strong>
        </div>
      </header>

      <section className={`question-card mt-5 ${selectedChoiceId ? 'answer-saved' : ''}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="category-chip">{categoryLabel}</span>
          <span className="text-sm text-[#aaa298]">เปลี่ยนคำตอบได้จนหมดเวลา</span>
        </div>
        {surgeOnThisQuestion ? (
          <p className="score-seal-banner" role="status">
            <strong>✦ พลังทวีคูณของทีมมีผลกับข้อนี้</strong>
            <span>คะแนนแข่งขันของทีมคูณสองในคำถามนี้</span>
          </p>
        ) : null}
        <h1 className="mt-5 text-xl font-semibold leading-relaxed sm:text-2xl">{question.question}</h1>
        {illusionHiddenChoiceIds.length > 0 ? (
          <p className="mt-2 text-xs text-[#c9a5f0]">✨ ตัดคำตอบผิดออกแล้ว 2 ตัว</p>
        ) : null}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {visibleChoices.map((choice, index) => (
            <button
              key={choice.id}
              className={`choice-button ${selectedChoiceId === choice.id ? 'choice-selected' : ''} ${revealed && selectedChoiceId === choice.id ? (answerWasCorrect ? 'choice-result-correct' : 'choice-result-wrong') : ''}`}
              type="button"
              onClick={() => void answerQuestion(choice.id)}
              disabled={areAnswersLocked(saving, timeExpired)}
            >
              <span>{['ก', 'ข', 'ค', 'ง'][index]}</span><strong>{choice.text}</strong>
            </button>
          ))}
        </div>
        <div className="feedback-region mt-5" aria-live="assertive">
          {error ? (
            <p className="error-message">{error}</p>
          ) : revealed && selectedChoiceId ? (
            <div className={answerWasCorrect ? 'answer-result-correct' : 'answer-result-wrong'}>
              <strong>{answerWasCorrect ? '✓ ตอบถูก' : '✕ ตอบผิด'}</strong>
              <span>เฉลยแล้ว — ผู้นำเสนอจะดำเนินการต่อ</span>
            </div>
          ) : revealed ? (
            <div className="answer-result-missed"><strong>ไม่ได้ตอบภายในเวลา</strong></div>
          ) : saving ? (
            <p>กำลังบันทึกคำตอบ...</p>
          ) : selectedChoiceId ? (
            <p className="answer-waiting"><span aria-hidden="true">✓</span> บันทึกแล้ว แตะตัวเลือกอื่นเพื่อเปลี่ยนได้จนหมดเวลา</p>
          ) : (
            <p>เลือกคำตอบของคุณเพื่อส่งให้ผู้นำเสนอเห็น</p>
          )}
        </div>
      </section>

      <p className="mx-auto mt-4 max-w-xl text-center text-xs leading-relaxed text-[#999187]">
        คำตอบนี้จะปรากฏบนหน้าผู้นำเสนอทันที โดยยังไม่บอกว่าถูกหรือผิดจนกว่าจะหมดเวลาและเฉลย
      </p>
    </Shell>
  )
}
