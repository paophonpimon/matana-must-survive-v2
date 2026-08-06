import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorPanel, LoadingPanel, ScenePage } from '../components/Layout'
import { useGame } from '../context/GameContext'
import { questionsById } from '../data/questions'
import { useRoom, usePlayer } from '../hooks/useGameData'
import { areAnswersLocked, getRemainingMilliseconds, getRevealRemainingMilliseconds } from '../lib/gameFlow'
import { friendlyError } from '../services'
import { getPlayerSession } from '../services/sessionStorage'

const formatCountdown = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export const GamePage = () => {
  const { roomCode = '' } = useParams()
  const normalizedCode = roomCode.toUpperCase()
  const navigate = useNavigate()
  const { service } = useGame()
  const session = getPlayerSession()
  const roomState = useRoom(normalizedCode)
  const playerState = usePlayer(normalizedCode, session?.roomCode === normalizedCode ? session.playerId : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingChoiceId, setPendingChoiceId] = useState('')
  const [now, setNow] = useState(Date.now())

  const room = roomState.data
  const player = playerState.data
  const assignedTeam = room?.teams.find((team) => team.id === player?.teamId)
  const questionIndex = room?.currentQuestionIndex ?? 0
  const questionId = room?.questionIds[questionIndex]
  const question = questionId ? questionsById.get(questionId) : undefined
  const savedAnswer = player?.answers.find((answer) => answer.questionId === questionId)
  const selectedChoiceId = pendingChoiceId || savedAnswer?.selectedChoiceId || ''
  const remainingMs = room ? getRemainingMilliseconds(room, now) : 0
  const revealRemainingMs = room ? getRevealRemainingMilliseconds(room, now) : 0
  const timeExpired = remainingMs <= 0
  const hasAnswered = Boolean(savedAnswer || pendingChoiceId)
  const answerWasCorrect = Boolean(selectedChoiceId && selectedChoiceId === question?.correctChoiceId)
  const progress = Math.min(100, (questionIndex / 10) * 100)

  useEffect(() => {
    if (room?.status !== 'playing') return
    setNow(Date.now())
    const intervalId = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(intervalId)
  }, [room?.status, room?.questionStartedAt])

  useEffect(() => {
    setPendingChoiceId('')
    setError('')
    setSaving(false)
  }, [questionId])

  useEffect(() => {
    if (!room || !player) return
    if (room.status === 'closed') navigate(`/closed/${normalizedCode}`, { replace: true })
    else if (room.winner) navigate(`/congratulations/${normalizedCode}`, { replace: true })
    else if (room.status === 'completed') navigate(`/result/${normalizedCode}`, { replace: true })
    else if (room.status === 'waiting') navigate(`/lobby/${normalizedCode}`, { replace: true })
  }, [navigate, normalizedCode, room, player])

  const categoryLabel = useMemo(() => {
    const labels = { basic: 'พื้นฐานเรื่อง', characters: 'ตัวละคร', plot: 'เนื้อเรื่อง', poetry: 'วรรณศิลป์', theme: 'แก่นเรื่อง' }
    return question ? labels[question.category] : ''
  }, [question])

  const answerQuestion = async (choiceId: string): Promise<void> => {
    if (!room || !player || !question || areAnswersLocked(saving, timeExpired) || selectedChoiceId === choiceId) return
    setSaving(true)
    setError('')
    setPendingChoiceId(choiceId)
    try {
      await service.saveAnswer(normalizedCode, player.id, {
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

  return (
    <ScenePage compact>
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-7">
        {roomState.loading || playerState.loading ? (
          <LoadingPanel text="กำลังนำคำถามกลับมา..." />
        ) : !session || session.roomCode !== normalizedCode ? (
          <ErrorPanel message="ไม่พบข้อมูลผู้เล่นบนอุปกรณ์นี้" action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : !room || !player ? (
          <ErrorPanel message={roomState.error || playerState.error || 'ไม่พบข้อมูลห้องหรือข้อมูลผู้เล่นของคุณ'} action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : room.status === 'completed' ? (
          <LoadingPanel text="กำลังสรุปคะแนน..." />
        ) : !question ? (
          <ErrorPanel message="ไม่พบคำถามของรอบนี้ กรุณาแจ้งครูผู้ควบคุมกิจกรรม" />
        ) : (
          <>
            <header className="game-header">
              <div className="min-w-0"><p className="text-xs text-[#aaa298]">ผู้เล่น</p><strong className="block truncate text-[#fff7df]">{player.displayName}</strong><small className="block truncate text-[#c0b7ab]">{assignedTeam?.name ?? 'ยังไม่ได้จัดทีม'}</small></div>
              <div className="text-right"><p className="text-xs text-[#aaa298]">รอบที่ {room.currentRound}</p><strong className={`question-timer ${remainingMs <= 5_000 ? 'question-timer-urgent' : ''}`}>{timeExpired ? 'หมดเวลา' : formatCountdown(remainingMs)}</strong></div>
            </header>

            <section className="mt-4" aria-label={`คำถามข้อ ${questionIndex + 1} จาก 10 ข้อ`}>
              <div className="mb-2 flex justify-between text-sm"><span>คำถามที่ {Math.min(questionIndex + 1, 10)} จาก 10</span><span className="text-[#c9a55f]">ทุกคนใช้เวลาเท่ากัน</span></div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            </section>

            <section className={`question-card mt-5 ${hasAnswered ? 'answer-saved' : ''}`}>
              <div className="flex items-center justify-between gap-3"><span className="category-chip">{categoryLabel}</span><span className="text-sm text-[#aaa298]">เปลี่ยนคำตอบได้จนหมดเวลา</span></div>
              <h1 className="mt-5 text-xl font-semibold leading-relaxed sm:text-2xl">{question.question}</h1>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {question.choices.map((choice, index) => (
                  <button
                    key={choice.id}
                    className={`choice-button ${selectedChoiceId === choice.id ? 'choice-selected' : ''} ${timeExpired && selectedChoiceId === choice.id ? answerWasCorrect ? 'choice-result-correct' : 'choice-result-wrong' : ''}`}
                    type="button"
                    onClick={() => void answerQuestion(choice.id)}
                    disabled={areAnswersLocked(saving, timeExpired)}
                  >
                    <span>{['ก', 'ข', 'ค', 'ง'][index]}</span><strong>{choice.text}</strong>
                  </button>
                ))}
              </div>
              <div className="feedback-region mt-5" aria-live="assertive">
                {error ? <p className="error-message">{error}</p> : timeExpired ? selectedChoiceId ? (
                  <div className={answerWasCorrect ? 'answer-result-correct' : 'answer-result-wrong'}>
                    <strong>{answerWasCorrect ? '✓ ตอบถูก +1 คะแนน' : '✕ ตอบผิด'}</strong>
                    <span>คะแนนสะสมของคุณ {player.score}/10</span>
                    <small>{revealRemainingMs > 0 ? `ไปข้อถัดไปใน ${Math.ceil(revealRemainingMs / 1_000)} วินาที` : 'กำลังไปคำถามข้อถัดไป'}</small>
                  </div>
                ) : (
                  <div className="answer-result-missed"><strong>ไม่ได้ตอบภายในเวลา</strong><span>คะแนนสะสมของคุณ {player.score}/10</span></div>
                ) : saving ? (
                  <p>กำลังบันทึกคำตอบ...</p>
                ) : hasAnswered ? (
                  <p className="answer-waiting"><span aria-hidden="true">✓</span> บันทึกแล้ว แตะตัวเลือกอื่นเพื่อเปลี่ยนได้จนหมดเวลา</p>
                ) : null}
              </div>
            </section>
            <p className="mx-auto mt-4 max-w-2xl text-center text-xs leading-relaxed text-[#999187]">เมื่อหมดเวลา ระบบจะแสดงว่าตอบถูกหรือผิดพร้อมคะแนนสะสมของคุณ แล้วทุกคนจึงเปลี่ยนข้อพร้อมกัน คำตอบของคุณเป็นความลับ เพื่อนร่วมทีมไม่เห็นคำตอบของคุณ</p>
          </>
        )}
      </div>
    </ScenePage>
  )
}
