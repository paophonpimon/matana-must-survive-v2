import { useEffect, useMemo, useRef, useState } from 'react'
import { BrandHeader, ConfirmDialog, ErrorPanel, LoadingPanel, ScenePage, StatusPill } from '../components/Layout'
import { useGame } from '../context/GameContext'
import { useRoom, useTeams } from '../hooks/useGameData'
import { ANSWER_REVEAL_MILLISECONDS, getQuestionDeadline, getRemainingMilliseconds, getRevealRemainingMilliseconds, getTeacherVisibleScore } from '../lib/gameFlow'
import { friendlyError } from '../services'
import { getTeacherSession, saveTeacherSession } from '../services/sessionStorage'

type ConfirmAction = 'prepare' | 'start' | 'stop' | 'close' | null

const formatCountdown = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
}

const RankEmblem = ({ rank, leading }: { rank: number; leading: boolean }) => (
  <span className={`team-rank-emblem team-rank-${Math.min(rank, 4)} ${leading ? 'team-rank-leading' : ''}`} aria-label={`อันดับ ${rank}`}>
    <svg viewBox="0 0 64 72" aria-hidden="true">
      <path className="emblem-shield" d="M32 3 55 11v20c0 17-10 29-23 37C19 60 9 48 9 31V11L32 3Z" />
      <path className="emblem-edge" d="M32 8 50 14v17c0 13-7 23-18 31-11-8-18-18-18-31V14L32 8Z" />
      {leading ? <path className="emblem-star" d="m32 18 3.8 8 8.7 1.1-6.4 6 1.7 8.6-7.8-4.2-7.8 4.2 1.7-8.6-6.4-6 8.7-1.1L32 18Z" /> : <text x="32" y="40" textAnchor="middle">{rank}</text>}
    </svg>
  </span>
)

export const TeacherPage = () => {
  const { service, uid } = useGame()
  const storedSession = getTeacherSession()
  const [teacherSessionId, setTeacherSessionId] = useState(storedSession?.teacherSessionId ?? uid)
  const [roomCode, setRoomCode] = useState(storedSession?.roomCode ?? '')
  const roomState = useRoom(roomCode)
  const teamsState = useTeams(roomCode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [durationValue, setDurationValue] = useState('30')
  const [durationUnit, setDurationUnit] = useState<'seconds' | 'minutes'>('seconds')
  const [now, setNow] = useState(Date.now())
  const advancingQuestion = useRef({ key: '', attemptedAt: 0 })

  const sortedTeams = useMemo(() => [...teamsState.data].sort((a, b) => a.joinedAt - b.joinedAt), [teamsState.data])
  const parsedDuration = Number(durationValue)
  const questionDurationSeconds = Math.round(parsedDuration * (durationUnit === 'minutes' ? 60 : 1))
  const durationValid = Number.isFinite(questionDurationSeconds) && questionDurationSeconds >= 5 && questionDurationSeconds <= 600
  const remainingMs = roomState.data ? getRemainingMilliseconds(roomState.data, now) : 0
  const revealRemainingMs = roomState.data ? getRevealRemainingMilliseconds(roomState.data, now) : 0
  const currentQuestionId = roomState.data?.questionIds[roomState.data.currentQuestionIndex]
  const displayedScores = useMemo(() => new Map(teamsState.data.map((team) => {
    const room = roomState.data
    return [team.id, room ? getTeacherVisibleScore(room, team, now) : team.score]
  })), [now, roomState.data, teamsState.data])
  const rankedTeams = useMemo(
    () => [...teamsState.data].sort((a, b) => (displayedScores.get(b.id) ?? 0) - (displayedScores.get(a.id) ?? 0) || a.teamName.localeCompare(b.teamName, 'th')),
    [displayedScores, teamsState.data],
  )
  const displayedTeams = roomState.data?.status === 'waiting' ? sortedTeams : rankedTeams
  const highestScore = rankedTeams[0] ? displayedScores.get(rankedTeams[0].id) ?? 0 : 0
  const averageScore = teamsState.data.length > 0
    ? teamsState.data.reduce((total, team) => total + (displayedScores.get(team.id) ?? 0), 0) / teamsState.data.length
    : 0
  const leadingTeams = rankedTeams.filter((team) => (displayedScores.get(team.id) ?? 0) === highestScore)
  const leadingTeamLabel = leadingTeams.length > 1
    ? `${leadingTeams.length} กลุ่มคะแนนเท่ากัน`
    : leadingTeams[0]?.teamName ?? '-'
  const podiumFollowers = rankedTeams
    .filter((team) => (displayedScores.get(team.id) ?? 0) < highestScore)
    .slice(0, 2)
  const answeredCurrentQuestion = currentQuestionId
    ? teamsState.data.filter((team) => team.answers.some((answer) => answer.questionId === currentQuestionId)).length
    : 0

  useEffect(() => {
    const room = roomState.data
    if (!room || room.status !== 'playing') return
    const questionKey = `${room.currentRound}-${room.currentQuestionIndex}`
    if (advancingQuestion.current.key && advancingQuestion.current.key !== questionKey) advancingQuestion.current = { key: '', attemptedAt: 0 }
    const tick = (): void => {
      const currentTime = Date.now()
      setNow(currentTime)
      const deadline = getQuestionDeadline(room)
      const recentlyAttempted = advancingQuestion.current.key === questionKey && currentTime - advancingQuestion.current.attemptedAt < 3_000
      if (deadline == null || currentTime < deadline + ANSWER_REVEAL_MILLISECONDS || recentlyAttempted) return
      advancingQuestion.current = { key: questionKey, attemptedAt: currentTime }
      void service.advanceQuestion(roomCode, teacherSessionId, room.currentQuestionIndex).catch((reason) => {
        advancingQuestion.current = { key: '', attemptedAt: 0 }
        setError(friendlyError(reason))
      })
    }
    tick()
    const intervalId = window.setInterval(tick, 250)
    return () => window.clearInterval(intervalId)
  }, [roomCode, roomState.data, service, teacherSessionId])

  const rememberRoom = (nextTeacherSessionId: string, nextRoomCode: string): void => {
    setTeacherSessionId(nextTeacherSessionId)
    setRoomCode(nextRoomCode)
    saveTeacherSession({ teacherSessionId: nextTeacherSessionId, roomCode: nextRoomCode, role: 'teacher' })
  }

  const createRoom = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const room = await service.createRoom(uid)
      rememberRoom(uid, room.roomCode)
      setNotice('สร้างห้องใหม่เรียบร้อยแล้ว ส่งรหัสนี้ให้ผู้เรียนได้เลย')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  const openDemoRoom = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const room = await service.resetDemoRoom?.()
      const demoRoomCode = room?.roomCode ?? service.demoRoomCode ?? 'MATANA'
      rememberRoom('demo-teacher', demoRoomCode)
      setNotice('รีเซ็ตห้องสาธิตพร้อม 3 กลุ่มตัวอย่างแล้ว สามารถเริ่มภารกิจได้ทันที')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  const copyCode = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(roomCode)
      setNotice('คัดลอกรหัสห้องแล้ว')
    } catch {
      setNotice(`รหัสห้องคือ ${roomCode}`)
    }
  }

  const runAction = async (action: Exclude<ConfirmAction, null>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (action === 'prepare') await service.prepareNextRound(roomCode, teacherSessionId)
      if (action === 'stop') await service.stopRound(roomCode, teacherSessionId)
      if (action === 'start') {
        if (!durationValid) throw new Error('ผู้ใช้:กำหนดเวลาต่อข้อระหว่าง 5 วินาทีถึง 10 นาที')
        await service.startRoom(roomCode, teacherSessionId, questionDurationSeconds)
      }
      if (action === 'close') await service.closeRoom(roomCode, teacherSessionId)
      setNotice(
        action === 'prepare'
          ? 'เตรียมภารกิจรอบใหม่แล้ว รายชื่อกลุ่มเดิมยังอยู่ครบ'
          : action === 'stop'
            ? 'หยุดเกมฉุกเฉินแล้ว ทุกกลุ่มกลับสู่ห้องรอและพร้อมเริ่มรอบใหม่'
            : action === 'start'
              ? `เริ่มภารกิจแล้ว ทุกกลุ่มมีเวลา ${questionDurationSeconds} วินาทีต่อข้อ`
              : 'ยุติห้องกิจกรรมแล้ว',
      )
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
      setConfirmAction(null)
    }
  }

  const requestStart = (): void => {
    if (roomState.data?.currentRound && roomState.data.currentRound > 1) setConfirmAction('start')
    else void runAction('start')
  }

  const dialogContent = {
    prepare: {
      title: 'เตรียมภารกิจรอบใหม่?',
      description: 'ระบบจะสุ่มคำถามชุดใหม่ ล้างคะแนนและคำตอบ แต่เก็บรายชื่อกลุ่มเดิมไว้',
      confirmLabel: 'เตรียมรอบใหม่',
    },
    start: {
      title: 'เริ่มภารกิจรอบใหม่?',
      description: `ทุกกลุ่มจะเข้าสู่คำถามพร้อมกันและมีเวลา ${questionDurationSeconds} วินาทีต่อข้อ คะแนนของแต่ละกลุ่มจะอัปเดตบนจอครูแบบเรียลไทม์`,
      confirmLabel: 'เริ่มรอบใหม่',
    },
    stop: {
      title: 'หยุดเกมฉุกเฉิน?',
      description: 'ระบบจะหยุดรอบที่กำลังเล่น ล้างคะแนนและคำตอบของรอบนี้ แล้วพาทุกกลุ่มกลับห้องรอ รายชื่อกลุ่มจะไม่หาย',
      confirmLabel: 'หยุดเกมและกลับห้องรอ',
    },
    close: {
      title: 'ยุติห้องกิจกรรม?',
      description: 'ผู้เรียนทุกกลุ่มจะออกจากภารกิจและไม่สามารถกลับเข้าห้องนี้ได้',
      confirmLabel: 'ยุติห้อง',
    },
  } as const

  const currentDialog = confirmAction ? dialogContent[confirmAction] : null
  const broadcastMode = roomState.data?.status === 'playing'
  const finalMode = roomState.data?.status === 'completed' || roomState.data?.status === 'closed'

  return (
    <ScenePage compact className={broadcastMode ? 'teacher-broadcast-mode' : finalMode ? 'teacher-final-page' : ''}>
      <BrandHeader backTo="/" />
      <div className="teacher-shell mx-auto w-full max-w-7xl flex-1 px-5 pb-10 pt-4 sm:px-8">
        <div className="teacher-intro mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">ศูนย์บัญชาการครู</p>
            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">ควบคุมภารกิจ</h1>
            <p className="mt-2 text-[#cfc7bb]">สร้างห้อง ติดตามทุกกลุ่ม และเริ่มรอบพร้อมกันจากหน้าจอนี้</p>
          </div>
          {service.isDemo ? <span className="demo-mode-pill"><i />โหมดสาธิต</span> : <span className="live-mode-pill"><i />Firebase realtime</span>}
        </div>

        {!roomCode ? (
          <section className="glass-panel mx-auto mt-10 max-w-2xl p-7 text-center sm:p-10">
            <div className="teacher-seal mx-auto" aria-hidden="true">ครู</div>
            <h2 className="mt-5 text-2xl font-semibold">สร้างประตูสู่ภารกิจ</h2>
            <p className="mx-auto mt-3 max-w-md text-[#d8d1c5]">ระบบจะสร้างรหัส 6 ตัวอักษรสำหรับทุกกลุ่มในห้องเรียน ใช้คำถามชุดและลำดับเดียวกัน</p>
            <button className="primary-button mx-auto mt-7 w-full max-w-sm" onClick={() => void createRoom()} disabled={busy}>
              <span>{busy ? 'กำลังสร้างห้อง...' : 'สร้างห้อง'}</span><span aria-hidden="true">✦</span>
            </button>
            {service.isDemo ? (
              <button className="secondary-button mx-auto mt-3 w-full max-w-sm" onClick={() => void openDemoRoom()} disabled={busy}>
                รีเซ็ตและเปิดห้องสาธิต {service.demoRoomCode}
              </button>
            ) : null}
            {error ? <p className="error-message mt-5" role="alert">{error}</p> : null}
          </section>
        ) : roomState.loading ? (
          <LoadingPanel text="กำลังโหลดศูนย์บัญชาการ..." />
        ) : !roomState.data ? (
          <ErrorPanel
            message={roomState.error || 'ไม่พบข้อมูลห้องนี้ อาจถูกลบหรือเซสชันหมดอายุ'}
            action={<button className="primary-button w-full" onClick={() => { setRoomCode(''); saveTeacherSession({ teacherSessionId: uid, role: 'teacher' }) }}>สร้างห้องใหม่</button>}
          />
        ) : (
          <>
            <section className="teacher-room-bar">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#b6ab9e]">รหัสห้อง</p>
                <div className="mt-1 flex items-center gap-3">
                  <strong className="room-code">{roomCode}</strong>
                  <button className="copy-button" onClick={() => void copyCode()} aria-label="คัดลอกรหัสห้อง">คัดลอก</button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-5 sm:flex sm:gap-8">
                <div><small>สถานะ</small><StatusPill status={roomState.data.status} /></div>
                <div><small>รอบที่</small><strong className="block text-2xl text-[#f2d58d]">{roomState.data.currentRound}</strong></div>
                {roomState.data.status === 'playing' ? (
                  <>
                    <div><small>คำถาม</small><strong className="block text-2xl text-[#fff7df]">{Math.min(roomState.data.currentQuestionIndex + 1, 10)}/10</strong></div>
                    <div><small>{revealRemainingMs > 0 ? 'กำลังแสดงผล' : 'เวลาคงเหลือ'}</small><strong className="block text-2xl text-[#f2d58d]">{revealRemainingMs > 0 ? formatCountdown(revealRemainingMs) : formatCountdown(remainingMs)}</strong></div>
                  </>
                ) : null}
                <div><small>กลุ่มทั้งหมด</small><strong className="block text-2xl text-[#fff7df]">{sortedTeams.length}</strong></div>
              </div>
            </section>

            {(error || (notice && !broadcastMode && !finalMode)) ? <div className={error ? 'error-message mt-4' : 'success-message mt-4'} role="status">{error || notice}</div> : null}

            {finalMode && rankedTeams.length > 0 ? (
              <section className="teacher-victory-stage" aria-labelledby="victory-stage-title">
                <div className="victory-fireworks" aria-hidden="true"><i /><i /><i /><i /></div>
                <div className="victory-rays" aria-hidden="true" />
                <div className="victory-stage-content">
                  <p className="victory-kicker">✦ ประกาศผลภารกิจรอบที่ {roomState.data.currentRound} ✦</p>
                  <h2 id="victory-stage-title">ผู้พิทักษ์อันดับหนึ่ง</h2>
                  <div className="champion-medal" aria-hidden="true"><span>1</span></div>
                  {leadingTeams.length > 1 ? <p className="champion-tie-label">{leadingTeamLabel}</p> : null}
                  <div className={`champion-team-list ${leadingTeams.length > 1 ? 'champion-team-list-tied' : ''}`}>
                    {leadingTeams.map((team) => (
                      <div className="champion-team" key={team.id}>
                        <strong>{team.teamName}</strong>
                        <span>ผู้พิทักษ์ {team.guardianName}</span>
                      </div>
                    ))}
                  </div>
                  <div className="champion-score"><strong>{highestScore}</strong><span>/10 คะแนน</span></div>
                  {podiumFollowers.length > 0 ? (
                    <div className={`podium-followers ${podiumFollowers.length === 1 ? 'podium-followers-single' : ''}`}>
                      {podiumFollowers.map((team) => {
                        const score = displayedScores.get(team.id) ?? 0
                        const rank = rankedTeams.findIndex((rankedTeam) => (displayedScores.get(rankedTeam.id) ?? 0) === score) + 1
                        return (
                          <article className={`podium-place podium-place-${Math.min(rank, 3)}`} key={team.id}>
                            <RankEmblem rank={rank} leading={false} />
                            <div><small>อันดับที่ {rank}</small><strong>{team.teamName}</strong><span>ผู้พิทักษ์ {team.guardianName}</span></div>
                            <b>{score}<span>/10</span></b>
                          </article>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            <div className={`teacher-dashboard mt-6 grid items-start gap-6 ${finalMode ? 'teacher-final-dashboard ' : ''}${broadcastMode ? '' : 'lg:grid-cols-[1.45fr_0.75fr]'}`}>
              <section className={`glass-panel teacher-scoreboard overflow-hidden ${broadcastMode ? 'teacher-scoreboard-live' : ''}`}>
                <div className="scoreboard-header">
                  <div>
                    <p className="eyebrow">
                      {roomState.data.status === 'playing' ? 'คะแนนสดแบบเรียลไทม์' : finalMode ? 'สรุปผลภารกิจ' : 'รายชื่อผู้เข้าร่วม'}
                    </p>
                    <h2>{roomState.data.status === 'waiting' ? 'กลุ่มผู้พิทักษ์' : 'กระดานคะแนนทุกกลุ่ม'}</h2>
                  </div>
                  {roomState.data.status === 'playing' ? (
                    <div className="broadcast-header-actions">
                      <span className="live-score-pill"><i />LIVE</span>
                      <button className="emergency-stop-button" type="button" onClick={() => setConfirmAction('stop')} disabled={busy}>หยุดเกม</button>
                    </div>
                  ) : <span className="count-badge">{sortedTeams.length} กลุ่ม</span>}
                </div>
                {roomState.data.status === 'playing' ? (
                  <dl className="broadcast-stats" aria-label="สถานการณ์ปัจจุบันของห้อง">
                    <div><dt>คำถามปัจจุบัน</dt><dd>{roomState.data.currentQuestionIndex + 1}<span>/10</span></dd></div>
                    <div><dt>{revealRemainingMs > 0 ? 'ดูเฉลยอีก' : 'เวลาคงเหลือ'}</dt><dd>{revealRemainingMs > 0 ? formatCountdown(revealRemainingMs) : formatCountdown(remainingMs)}</dd></div>
                    <div><dt>ตอบแล้วข้อนี้</dt><dd>{answeredCurrentQuestion}<span>/{sortedTeams.length}</span></dd></div>
                    <div><dt>คะแนนเฉลี่ย</dt><dd>{averageScore.toFixed(1)}</dd></div>
                  </dl>
                ) : null}
                {roomState.data.status === 'playing' && rankedTeams.length > 0 ? (
                  <section className="scoreboard-spotlight" aria-label="กลุ่มที่กำลังนำ">
                    <span className="scoreboard-crown" aria-hidden="true">♛</span>
                    <div className="scoreboard-spotlight-copy">
                      <small>{leadingTeams.length > 1 ? 'คะแนนนำร่วมขณะนี้' : 'ผู้นำขณะนี้'}</small>
                      <strong>{leadingTeamLabel}</strong>
                      <span>{leadingTeams.length === 1 ? `ผู้พิทักษ์ ${leadingTeams[0].guardianName}` : 'ทุกคะแนนจะจัดอันดับใหม่หลังหมดเวลาของแต่ละข้อ'}</span>
                    </div>
                    <div className="scoreboard-spotlight-score">
                      <small>คะแนนสด</small>
                      <b>{highestScore}<span>/10</span></b>
                    </div>
                  </section>
                ) : null}
                {teamsState.loading ? (
                  <div className="p-8 text-center text-[#cfc7bb]">กำลังโหลดรายชื่อกลุ่ม...</div>
                ) : sortedTeams.length === 0 ? (
                  <div className="empty-state">
                    <div aria-hidden="true">✦</div>
                    <h3>ยังไม่มีกลุ่มเข้าร่วม</h3>
                    <p>ส่งรหัส <strong>{roomCode}</strong> ให้ผู้เรียน แล้วรายชื่อจะปรากฏที่นี่แบบ realtime</p>
                  </div>
                ) : (
                  <ol className="scoreboard-list" aria-live="polite">
                    {displayedTeams.map((team, index) => {
                      const answeredCount = team.answers.length
                      const answeredThisQuestion = team.answers.some((answer) => answer.questionId === currentQuestionId)
                      const displayedScore = displayedScores.get(team.id) ?? 0
                      const isLeader = roomState.data?.status !== 'waiting' && highestScore > 0 && displayedScore === highestScore
                      const rankNumber = roomState.data?.status === 'waiting'
                        ? index + 1
                        : rankedTeams.findIndex((rankedTeam) => (displayedScores.get(rankedTeam.id) ?? 0) === displayedScore) + 1
                      const teamStatus = finalMode
                        ? roomState.data?.status === 'closed' ? 'สรุปแล้ว' : 'จบรอบแล้ว'
                        : team.status === 'waiting'
                          ? 'รอเริ่ม'
                          : team.status === 'playing'
                            ? revealRemainingMs > 0 ? 'กำลังดูเฉลย' : answeredThisQuestion ? 'ตอบแล้ว' : 'กำลังตอบ'
                        : team.status === 'submitted' ? 'ส่งครบแล้ว' : 'หยุดแล้ว'
                      return (
                        <li key={team.id} className={`scoreboard-row ${isLeader ? 'scoreboard-row-leading' : ''}`}>
                          <RankEmblem rank={rankNumber} leading={isLeader} />
                          <div className="scoreboard-team">
                            <strong>{team.teamName}</strong>
                            <small>ผู้พิทักษ์ {team.guardianName}</small>
                            <div className="scoreboard-progress" aria-label={`ตอบแล้ว ${answeredCount} จาก 10 ข้อ`}><i style={{ width: `${Math.min(answeredCount, 10) * 10}%` }} /></div>
                            <span>ตอบแล้ว {answeredCount}/10 ข้อ</span>
                          </div>
                          <span className={`team-status team-status-${team.status}`}>{teamStatus}</span>
                          <div className="scoreboard-score"><small>คะแนน</small><strong>{displayedScore}<span>/10</span></strong></div>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </section>

              {!broadcastMode ? <aside className="space-y-5">
                {roomState.data.status !== 'waiting' ? (
                  <section className="teacher-live-summary" aria-label="ภาพรวมคะแนนของห้อง">
                    <div className="teacher-live-summary-heading">
                      <div><p className="eyebrow">{roomState.data.status === 'playing' ? 'ภาพรวมสด' : 'สรุปรอบนี้'}</p><h2>{roomState.data.status === 'playing' ? 'สถานการณ์ในห้อง' : 'ผลคะแนนรวม'}</h2></div>
                      {roomState.data.status === 'playing' ? <span className="summary-orb" aria-hidden="true">{roomState.data.currentQuestionIndex + 1}</span> : <span className="summary-orb" aria-hidden="true">✦</span>}
                    </div>
                    <dl className="teacher-summary-grid">
                      <div>
                        <dt>{roomState.data.status === 'playing' ? 'ตอบข้อปัจจุบัน' : 'คะแนนสูงสุด'}</dt>
                        <dd>{roomState.data.status === 'playing' ? `${answeredCurrentQuestion}/${sortedTeams.length}` : `${highestScore}/10`}</dd>
                      </div>
                      <div><dt>คะแนนเฉลี่ย</dt><dd>{averageScore.toFixed(1)}</dd></div>
                      <div><dt>กลุ่มทั้งหมด</dt><dd>{sortedTeams.length}</dd></div>
                    </dl>
                    {roomState.data.status === 'playing' ? (
                      <div className="teacher-answer-progress"><i style={{ width: `${sortedTeams.length > 0 ? (answeredCurrentQuestion / sortedTeams.length) * 100 : 0}%` }} /></div>
                    ) : null}
                  </section>
                ) : null}
                <section className="glass-panel p-5">
                  <p className="eyebrow">การควบคุม</p>
                  <div className="mt-4 space-y-3">
                    {roomState.data.status === 'waiting' ? (
                      <>
                        <div className="timer-setting">
                          <label htmlFor="question-duration">เวลาต่อคำถาม</label>
                          <div>
                            <input id="question-duration" type="number" min={durationUnit === 'seconds' ? 5 : 1} max={durationUnit === 'seconds' ? 600 : 10} step="1" value={durationValue} onChange={(event) => setDurationValue(event.target.value)} />
                            <select value={durationUnit} onChange={(event) => { const nextUnit = event.target.value as 'seconds' | 'minutes'; setDurationUnit(nextUnit); setDurationValue(nextUnit === 'minutes' ? '1' : '30') }} aria-label="หน่วยเวลา">
                              <option value="seconds">วินาที</option>
                              <option value="minutes">นาที</option>
                            </select>
                          </div>
                          <small>กำหนดได้ตั้งแต่ 5 วินาทีถึง 10 นาที ทุกกลุ่มใช้เวลาเท่ากัน</small>
                        </div>
                        <button className="primary-button w-full" onClick={requestStart} disabled={busy || sortedTeams.length === 0 || !durationValid}>
                          {roomState.data.currentRound === 1 ? 'เริ่มภารกิจพร้อมจับเวลา' : 'เริ่มรอบใหม่พร้อมจับเวลา'}
                        </button>
                      </>
                    ) : null}
                    {roomState.data.status === 'completed' ? (
                      <button className="primary-button w-full" onClick={() => setConfirmAction('prepare')} disabled={busy}>เตรียมภารกิจรอบใหม่</button>
                    ) : null}
                    {roomState.data.status !== 'closed' ? (
                      <button className="danger-button w-full" onClick={() => setConfirmAction('close')} disabled={busy}>ยุติห้อง</button>
                    ) : (
                      service.isDemo && roomCode === service.demoRoomCode ? (
                        <button className="primary-button w-full" onClick={() => void openDemoRoom()} disabled={busy}>รีเซ็ตห้องสาธิต {service.demoRoomCode}</button>
                      ) : (
                        <button className="secondary-button w-full" onClick={() => { setRoomCode(''); setNotice('') }}>สร้างห้องใหม่</button>
                      )
                    )}
                    {service.isDemo && roomState.data.status !== 'playing' && roomState.data.status !== 'closed' ? (
                      <button className="secondary-button w-full" onClick={() => void createRoom()} disabled={busy}>สร้างห้องทดสอบใหม่</button>
                    ) : null}
                  </div>
                  {roomState.data.status === 'waiting' && sortedTeams.length === 0 ? <p className="mt-3 text-sm text-[#bdb5ac]">ปุ่มเริ่มจะใช้งานได้เมื่อมีอย่างน้อย 1 กลุ่ม</p> : null}
                </section>
              </aside> : null}
            </div>
          </>
        )}
      </div>

      {currentDialog && confirmAction ? (
        <ConfirmDialog
          open
          title={currentDialog.title}
          description={currentDialog.description}
          confirmLabel={currentDialog.confirmLabel}
          destructive={confirmAction === 'close' || confirmAction === 'stop'}
          busy={busy}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => void runAction(confirmAction)}
        />
      ) : null}
    </ScenePage>
  )
}
