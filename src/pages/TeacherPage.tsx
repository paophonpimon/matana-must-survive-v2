import { useEffect, useMemo, useRef, useState } from 'react'
import { BrandHeader, ConfirmDialog, ErrorPanel, LoadingPanel, ScenePage, StatusPill } from '../components/Layout'
import { useGame } from '../context/GameContext'
import { useAllTeamMagic, useMagicEvents, useRoom, usePlayers } from '../hooks/useGameData'
import { ANSWER_REVEAL_MILLISECONDS, getQuestionDeadline, getRemainingMilliseconds, getRevealRemainingMilliseconds, getTeacherVisibleScore } from '../lib/gameFlow'
import { resolveTeacherRoomSession } from '../lib/game'
import { computeTeamCompetitionStats, MAGIC_ITEM_INFO } from '../lib/magic'
import { computeCurrentQuestionStats, computeTeamCurrentQuestionCounts, computeTeamStats } from '../lib/teamScoring'
import { friendlyError } from '../services'
import { getTeacherSession, saveTeacherSession } from '../services/sessionStorage'
import type { Player } from '../types/game'

type ConfirmAction = 'prepare' | 'start' | 'stop' | 'close' | null

const formatCountdown = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
}

const formatResponseTime = (responseTimeMs: number): string => `${Math.max(0, responseTimeMs / 1_000).toFixed(1)} วิ`

const RankEmblem = ({ rank, leading }: { rank: number; leading: boolean }) => (
  <span className={`team-rank-emblem team-rank-${Math.min(rank, 4)} ${leading ? 'team-rank-leading' : ''}`} aria-label={`อันดับ ${rank}`}>
    <svg viewBox="0 0 64 72" aria-hidden="true">
      <path className="emblem-shield" d="M32 3 55 11v20c0 17-10 29-23 37C19 60 9 48 9 31V11L32 3Z" />
      <path className="emblem-edge" d="M32 8 50 14v17c0 13-7 23-18 31-11-8-18-18-18-31V14L32 8Z" />
      {leading ? <path className="emblem-star" d="m32 18 3.8 8 8.7 1.1-6.4 6 1.7 8.6-7.8-4.2-7.8 4.2 1.7-8.6-6.4-6 8.7-1.1L32 18Z" /> : <text x="32" y="40" textAnchor="middle">{rank}</text>}
    </svg>
  </span>
)

const IndividualResultsTable = ({ players, questionIds, teamNameById }: {
  players: Player[]
  questionIds: string[]
  teamNameById: Map<string, string>
}) => (
  <div className="overflow-x-auto p-5">
    <table className="w-full min-w-[720px] text-left text-sm">
      <thead>
        <tr className="text-xs uppercase tracking-wide text-[#b6ab9e]">
          <th className="pb-3 pr-3">ชื่อผู้เล่น</th>
          <th className="pb-3 pr-3">เลขที่</th>
          <th className="pb-3 pr-3">ทีม</th>
          {questionIds.map((_, index) => (
            <th key={index} className="pb-3 pr-2 text-center">ข้อ {index + 1}</th>
          ))}
          <th className="pb-3 pr-3 text-center">คะแนนดิบ</th>
          <th className="pb-3 text-center">ไม่ได้ตอบ</th>
        </tr>
      </thead>
      <tbody>
        {players.map((player) => {
          const unansweredCount = questionIds.filter((questionId) => !player.answers.some((answer) => answer.questionId === questionId)).length
          return (
            <tr key={player.id} className="border-t border-white/10">
              <td className="py-2 pr-3 text-[#fff7df]">{player.displayName}</td>
              <td className="py-2 pr-3 text-[#c0b7ab]">{player.studentNumber}</td>
              <td className="py-2 pr-3 text-[#c0b7ab]">{teamNameById.get(player.teamId ?? '') ?? 'ยังไม่ได้จัดทีม'}</td>
              {questionIds.map((questionId) => {
                const answer = player.answers.find((item) => item.questionId === questionId)
                const symbol = !answer ? '–' : answer.isCorrect ? '✓' : '✕'
                const title = !answer
                  ? 'ไม่ได้ตอบ'
                  : `เลือก ${answer.selectedChoiceId} · ${answer.isCorrect ? 'ถูก' : 'ผิด'} · ใช้เวลา ${formatResponseTime(answer.responseTimeMs)}`
                return (
                  <td key={questionId} className="py-2 pr-2 text-center" title={title}>
                    <span className={!answer ? 'text-[#8b8377]' : answer.isCorrect ? 'text-[#7fdc9d]' : 'text-[#e08a8a]'}>{symbol}</span>
                  </td>
                )
              })}
              <td className="py-2 pr-3 text-center font-semibold text-[#f2d58d]">{player.score}</td>
              <td className="py-2 text-center text-[#c0b7ab]">{unansweredCount}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  </div>
)

export const TeacherPage = () => {
  const { service, uid } = useGame()
  // uid here is the stable, authoritative Firebase uid (GameContext only resolves it via
  // ensureAnonymousUser). A locally stored session from an earlier browser identity must
  // never override it — if the stored teacherSessionId doesn't match, that old room is
  // treated as not owned by this browser rather than silently reused.
  const initialTeacherSession = resolveTeacherRoomSession(getTeacherSession(), uid)
  const [teacherSessionId, setTeacherSessionId] = useState(initialTeacherSession.teacherSessionId)
  const [roomCode, setRoomCode] = useState(initialTeacherSession.roomCode)
  const roomState = useRoom(roomCode)
  const playersState = usePlayers(roomCode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null)
  const [durationValue, setDurationValue] = useState('30')
  const [durationUnit, setDurationUnit] = useState<'seconds' | 'minutes'>('seconds')
  const [teamCountValue, setTeamCountValue] = useState('2')
  const [resultsTab, setResultsTab] = useState<'team' | 'individual'>('team')
  const [now, setNow] = useState(Date.now())
  const advancingQuestion = useRef({ key: '', attemptedAt: 0 })

  const sortedPlayers = useMemo(() => [...playersState.data].sort((a, b) => a.joinedAt - b.joinedAt), [playersState.data])
  const parsedDuration = Number(durationValue)
  const questionDurationSeconds = Math.round(parsedDuration * (durationUnit === 'minutes' ? 60 : 1))
  const durationValid = Number.isFinite(questionDurationSeconds) && questionDurationSeconds >= 5 && questionDurationSeconds <= 600
  const parsedTeamCount = Math.round(Number(teamCountValue))
  const teamCountValid = Number.isFinite(parsedTeamCount) && parsedTeamCount >= 1 && parsedTeamCount <= 20
  const remainingMs = roomState.data ? getRemainingMilliseconds(roomState.data, now) : 0
  const revealRemainingMs = roomState.data ? getRevealRemainingMilliseconds(roomState.data, now) : 0
  const currentQuestionId = roomState.data?.questionIds[roomState.data.currentQuestionIndex]

  // While a question is live, hide each player's just-answered (unrevealed) score bump from
  // the teacher view the same way the previous per-login-team scoreboard did — this now
  // feeds team aggregation too, so a team's live average can't be gamed by watching reveals.
  const visiblePlayers = useMemo(() => {
    const room = roomState.data
    if (!room || room.status !== 'playing') return playersState.data
    return playersState.data.map((player) => ({ ...player, score: getTeacherVisibleScore(room, player, now) }))
  }, [now, playersState.data, roomState.data])

  const magicState = useAllTeamMagic(roomCode)
  const magicEventsState = useMagicEvents(roomCode)

  // teamStats stays raw (memberCount/submittedCount/correctCount/full-game completion) — the
  // magic-item system must never touch it. competitionStats is the magic-adjusted score shown
  // as the primary teacher leaderboard ranking, per the core rule that items affect only the
  // competition score. Both are fed the same reveal-hiding visiblePlayers so a team's live
  // score (raw or competition) can't be gamed by watching the current question's reveal.
  const teamStats = useMemo(
    () => computeTeamStats(visiblePlayers, roomState.data?.teams ?? []),
    [visiblePlayers, roomState.data?.teams],
  )
  const competitionStats = useMemo(
    () => computeTeamCompetitionStats(
      visiblePlayers,
      roomState.data?.teams ?? [],
      roomState.data?.questionIds ?? [],
      magicEventsState.data,
      roomState.data?.currentRound ?? 1,
    ),
    [visiblePlayers, roomState.data?.teams, roomState.data?.questionIds, roomState.data?.currentRound, magicEventsState.data],
  )
  const teamStatsById = useMemo(() => new Map(teamStats.map((team) => [team.id, team])), [teamStats])
  const currentQuestionStats = useMemo(
    () => computeCurrentQuestionStats(playersState.data, currentQuestionId),
    [playersState.data, currentQuestionId],
  )
  const currentQuestionCounts = useMemo(
    () => computeTeamCurrentQuestionCounts(playersState.data, roomState.data?.teams ?? [], currentQuestionId),
    [playersState.data, roomState.data?.teams, currentQuestionId],
  )
  const teamNameById = useMemo(() => new Map((roomState.data?.teams ?? []).map((team) => [team.id, team.name])), [roomState.data?.teams])
  const magicByTeamId = useMemo(() => new Map(magicState.data.map((magic) => [magic.teamId, magic])), [magicState.data])
  const playerNameById = useMemo(() => new Map(playersState.data.map((player) => [player.id, player.displayName])), [playersState.data])

  const highestAverage = competitionStats[0]?.competitionAverage ?? 0
  const overallAverage = competitionStats.length > 0 ? competitionStats.reduce((total, team) => total + team.competitionAverage, 0) / competitionStats.length : 0
  const leadingTeams = competitionStats.filter((team) => team.memberCount > 0 && team.competitionAverage === highestAverage)
  const leadingTeamLabel = leadingTeams.length > 1 ? `${leadingTeams.length} ทีมคะแนนเท่ากัน` : leadingTeams[0]?.name ?? '-'
  const podiumFollowers = competitionStats.filter((team) => team.competitionAverage < highestAverage).slice(0, 2)
  const unassignedCount = sortedPlayers.filter((player) => player.teamId == null).length

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
      setNotice('รีเซ็ตห้องสาธิตพร้อมผู้เล่นตัวอย่าง 3 คนแล้ว กรุณาสุ่มและล็อกทีมก่อนเริ่มภารกิจ')
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

  const randomizeTeams = async (): Promise<void> => {
    if (!teamCountValid) return
    setBusy(true)
    setError('')
    try {
      await service.randomizeTeams(roomCode, teacherSessionId, parsedTeamCount)
      setNotice(`สุ่มทีมแล้ว (${parsedTeamCount} ทีม) สุ่มใหม่ได้จนกว่าจะล็อกทีม`)
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  const toggleTeamLock = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (roomState.data?.teamsLocked) {
        await service.unlockTeams(roomCode, teacherSessionId)
        setNotice('ปลดล็อกทีมแล้ว สามารถสุ่มทีมใหม่ได้')
      } else {
        await service.lockTeams(roomCode, teacherSessionId)
        setNotice('ล็อกทีมแล้ว ผู้เล่นจะเห็นทีมของตนเองแล้ว')
      }
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
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
          ? 'เตรียมภารกิจรอบใหม่แล้ว รายชื่อและทีมเดิมยังอยู่ครบ'
          : action === 'stop'
            ? 'หยุดเกมฉุกเฉินแล้ว ทุกคนกลับสู่ห้องรอและพร้อมเริ่มรอบใหม่'
            : action === 'start'
              ? `เริ่มภารกิจแล้ว ทุกคนมีเวลา ${questionDurationSeconds} วินาทีต่อข้อ`
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
      description: 'ระบบจะสุ่มคำถามชุดใหม่ ล้างคะแนนและคำตอบ แต่เก็บรายชื่อผู้เล่นและทีมเดิมไว้',
      confirmLabel: 'เตรียมรอบใหม่',
    },
    start: {
      title: 'เริ่มภารกิจรอบใหม่?',
      description: `ทุกคนจะเข้าสู่คำถามพร้อมกันและมีเวลา ${questionDurationSeconds} วินาทีต่อข้อ คะแนนของแต่ละทีมจะอัปเดตบนจอครูแบบเรียลไทม์`,
      confirmLabel: 'เริ่มรอบใหม่',
    },
    stop: {
      title: 'หยุดเกมฉุกเฉิน?',
      description: 'ระบบจะหยุดรอบที่กำลังเล่น ล้างคะแนนและคำตอบของรอบนี้ แล้วพาทุกคนกลับห้องรอ รายชื่อและทีมจะไม่หาย',
      confirmLabel: 'หยุดเกมและกลับห้องรอ',
    },
    close: {
      title: 'ยุติห้องกิจกรรม?',
      description: 'ผู้เรียนทุกคนจะออกจากภารกิจและไม่สามารถกลับเข้าห้องนี้ได้',
      confirmLabel: 'ยุติห้อง',
    },
  } as const

  const currentDialog = confirmAction ? dialogContent[confirmAction] : null
  const broadcastMode = roomState.data?.status === 'playing'
  const finalMode = roomState.data?.status === 'completed' || roomState.data?.status === 'closed'
  const showIndividualResults = finalMode && resultsTab === 'individual'

  return (
    <ScenePage compact className={broadcastMode ? 'teacher-broadcast-mode' : finalMode ? 'teacher-final-page' : ''}>
      <BrandHeader backTo="/" />
      <div className="teacher-shell mx-auto w-full max-w-7xl flex-1 px-5 pb-10 pt-4 sm:px-8">
        <div className="teacher-intro mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">ศูนย์บัญชาการครู</p>
            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">ควบคุมภารกิจ</h1>
            <p className="mt-2 text-[#cfc7bb]">สร้างห้อง จัดทีม ติดตามทุกคน และเริ่มรอบพร้อมกันจากหน้าจอนี้</p>
          </div>
          {service.isDemo ? <span className="demo-mode-pill"><i />โหมดสาธิต</span> : <span className="live-mode-pill"><i />Firebase realtime</span>}
        </div>

        {!roomCode ? (
          <section className="glass-panel mx-auto mt-10 max-w-2xl p-7 text-center sm:p-10">
            <div className="teacher-seal mx-auto" aria-hidden="true">ครู</div>
            <h2 className="mt-5 text-2xl font-semibold">สร้างประตูสู่ภารกิจ</h2>
            <p className="mx-auto mt-3 max-w-md text-[#d8d1c5]">ระบบจะสร้างรหัส 6 ตัวอักษรสำหรับผู้เรียนทุกคนในห้องเรียน ใช้คำถามชุดและลำดับเดียวกัน</p>
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
                <div><small>ผู้เล่นทั้งหมด</small><strong className="block text-2xl text-[#fff7df]">{sortedPlayers.length}</strong></div>
                <div><small>ทีมทั้งหมด</small><strong className="block text-2xl text-[#fff7df]">{roomState.data.teams.length}</strong></div>
              </div>
            </section>

            {(error || (notice && !broadcastMode && !finalMode)) ? <div className={error ? 'error-message mt-4' : 'success-message mt-4'} role="status">{error || notice}</div> : null}

            {finalMode && teamStats.length > 0 ? (
              <section className="teacher-victory-stage" aria-labelledby="victory-stage-title">
                <div className="victory-fireworks" aria-hidden="true"><i /><i /><i /><i /></div>
                <div className="victory-rays" aria-hidden="true" />
                <div className="victory-stage-content">
                  <p className="victory-kicker">✦ ประกาศผลภารกิจรอบที่ {roomState.data.currentRound} ✦</p>
                  <h2 id="victory-stage-title">ทีมอันดับหนึ่ง</h2>
                  <div className="champion-medal" aria-hidden="true"><span>1</span></div>
                  {leadingTeams.length > 1 ? <p className="champion-tie-label">{leadingTeamLabel}</p> : null}
                  <div className={`champion-team-list ${leadingTeams.length > 1 ? 'champion-team-list-tied' : ''}`}>
                    {leadingTeams.map((team) => (
                      <div className="champion-team" key={team.id}>
                        <strong>{team.name}</strong>
                        <span>{sortedPlayers.filter((player) => player.teamId === team.id).map((player) => player.displayName).join(', ')}</span>
                      </div>
                    ))}
                  </div>
                  <div className="champion-score"><strong>{highestAverage.toFixed(1)}</strong><span>คะแนนเฉลี่ย</span></div>
                  {podiumFollowers.length > 0 ? (
                    <div className={`podium-followers ${podiumFollowers.length === 1 ? 'podium-followers-single' : ''}`}>
                      {podiumFollowers.map((team) => {
                        const rank = competitionStats.findIndex((rankedTeam) => rankedTeam.id === team.id) + 1
                        return (
                          <article className={`podium-place podium-place-${Math.min(rank, 3)}`} key={team.id}>
                            <RankEmblem rank={rank} leading={false} />
                            <div><small>อันดับที่ {rank}</small><strong>{team.name}</strong><span>{team.memberCount} คน</span></div>
                            <b>{team.competitionAverage.toFixed(1)}<span>เฉลี่ย</span></b>
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
                    <h2>{roomState.data.status === 'waiting' ? 'ผู้เล่นและทีม' : 'กระดานคะแนนทุกทีม'}</h2>
                  </div>
                  {roomState.data.status === 'playing' ? (
                    <div className="broadcast-header-actions">
                      <span className="live-score-pill"><i />LIVE</span>
                      <button className="emergency-stop-button" type="button" onClick={() => setConfirmAction('stop')} disabled={busy}>หยุดเกม</button>
                    </div>
                  ) : finalMode ? (
                    <div className="broadcast-header-actions" role="tablist" aria-label="มุมมองผลคะแนน">
                      <button type="button" className={resultsTab === 'team' ? 'live-score-pill' : 'copy-button'} onClick={() => setResultsTab('team')} aria-pressed={resultsTab === 'team'}>ทีม</button>
                      <button type="button" className={resultsTab === 'individual' ? 'live-score-pill' : 'copy-button'} onClick={() => setResultsTab('individual')} aria-pressed={resultsTab === 'individual'}>รายบุคคล</button>
                    </div>
                  ) : <span className="count-badge">{sortedPlayers.length} คน</span>}
                </div>
                {roomState.data.status === 'playing' ? (
                  <dl className="broadcast-stats" aria-label="สถานการณ์ปัจจุบันของห้อง">
                    <div><dt>คำถามปัจจุบัน</dt><dd>{roomState.data.currentQuestionIndex + 1}<span>/10</span></dd></div>
                    <div><dt>{revealRemainingMs > 0 ? 'ดูเฉลยอีก' : 'เวลาคงเหลือ'}</dt><dd>{revealRemainingMs > 0 ? formatCountdown(revealRemainingMs) : formatCountdown(remainingMs)}</dd></div>
                    <div><dt>ตอบแล้วข้อนี้</dt><dd>{currentQuestionStats.answeredCount}<span>/{sortedPlayers.length}</span></dd></div>
                    <div><dt>ถูกข้อนี้</dt><dd>{currentQuestionStats.correctCount}<span>/{sortedPlayers.length}</span></dd></div>
                    <div><dt>คะแนนเฉลี่ยทีม</dt><dd>{overallAverage.toFixed(1)}</dd></div>
                  </dl>
                ) : null}
                {roomState.data.status === 'playing' && teamStats.length > 0 ? (
                  <section className="scoreboard-spotlight" aria-label="ทีมที่กำลังนำ">
                    <span className="scoreboard-crown" aria-hidden="true">♛</span>
                    <div className="scoreboard-spotlight-copy">
                      <small>{leadingTeams.length > 1 ? 'คะแนนนำร่วมขณะนี้' : 'ทีมนำขณะนี้'}</small>
                      <strong>{leadingTeamLabel}</strong>
                      <span>{leadingTeams.length === 1 ? `สมาชิก ${leadingTeams[0].memberCount} คน` : 'ทุกคะแนนจะจัดอันดับใหม่หลังหมดเวลาของแต่ละข้อ'}</span>
                    </div>
                    <div className="scoreboard-spotlight-score">
                      <small>คะแนนเฉลี่ย</small>
                      <b>{highestAverage.toFixed(1)}</b>
                    </div>
                  </section>
                ) : null}

                {roomState.data.status === 'waiting' ? (
                  playersState.loading ? (
                    <div className="p-8 text-center text-[#cfc7bb]">กำลังโหลดรายชื่อผู้เล่น...</div>
                  ) : sortedPlayers.length === 0 ? (
                    <div className="empty-state">
                      <div aria-hidden="true">✦</div>
                      <h3>ยังไม่มีผู้เล่นเข้าร่วม</h3>
                      <p>ส่งรหัส <strong>{roomCode}</strong> ให้ผู้เรียน แล้วรายชื่อจะปรากฏที่นี่แบบ realtime</p>
                    </div>
                  ) : (
                    <ol className="scoreboard-list" aria-live="polite">
                      {sortedPlayers.map((player, index) => (
                        <li key={player.id} className="scoreboard-row">
                          <RankEmblem rank={index + 1} leading={false} />
                          <div className="scoreboard-team">
                            <strong>{player.displayName}</strong>
                            <small>เลขที่ {player.studentNumber}</small>
                          </div>
                          <span className="team-status team-status-waiting">
                            {roomState.data?.teamsLocked
                              ? teamNameById.get(player.teamId ?? '') ?? 'ยังไม่ได้จัดทีม'
                              : player.teamId
                                ? `${teamNameById.get(player.teamId) ?? ''} (ยังไม่ล็อก)`
                                : 'ยังไม่ได้จัดทีม'}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )
                ) : showIndividualResults ? (
                  <IndividualResultsTable players={sortedPlayers} questionIds={roomState.data.questionIds} teamNameById={teamNameById} />
                ) : competitionStats.length === 0 ? (
                  <div className="empty-state">
                    <div aria-hidden="true">✦</div>
                    <h3>ยังไม่มีทีม</h3>
                  </div>
                ) : (
                  <ol className="scoreboard-list" aria-live="polite">
                    {competitionStats.map((team, index) => {
                      const isLeader = highestAverage > 0 && team.competitionAverage === highestAverage && team.memberCount > 0
                      const fullGame = teamStatsById.get(team.id)
                      const currentQuestionCount = currentQuestionCounts.get(team.id) ?? 0
                      return (
                        <li key={team.id} className={`scoreboard-row ${isLeader ? 'scoreboard-row-leading' : ''}`}>
                          <RankEmblem rank={index + 1} leading={isLeader} />
                          <div className="scoreboard-team">
                            <strong>{team.name}</strong>
                            <small>
                              {team.memberCount} คน
                              {roomState.data?.status === 'playing' ? ` · ตอบแล้ว ${currentQuestionCount}/${team.memberCount}` : ''}
                              {' · เล่นจบ '}{fullGame?.submittedCount ?? 0}/{team.memberCount}
                              {' · ถูก '}{fullGame?.correctCount ?? 0} ข้อ
                            </small>
                            <div className="scoreboard-progress" aria-label={`เล่นจบแล้ว ${fullGame?.submittedCount ?? 0} จาก ${team.memberCount} คน`}><i style={{ width: `${team.memberCount > 0 ? ((fullGame?.submittedCount ?? 0) / team.memberCount) * 100 : 0}%` }} /></div>
                          </div>
                          <span className={`team-status team-status-${finalMode ? (roomState.data?.status === 'closed' ? 'stopped' : 'submitted') : 'playing'}`}>
                            {finalMode ? (roomState.data?.status === 'closed' ? 'สรุปแล้ว' : 'จบรอบแล้ว') : 'กำลังเล่น'}
                          </span>
                          <div className="scoreboard-score"><small>เฉลี่ย</small><strong>{team.competitionAverage.toFixed(1)}</strong></div>
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
                        <dt>{roomState.data.status === 'playing' ? 'ตอบข้อปัจจุบัน' : 'คะแนนเฉลี่ยสูงสุด'}</dt>
                        <dd>{roomState.data.status === 'playing' ? `${currentQuestionStats.answeredCount}/${sortedPlayers.length}` : highestAverage.toFixed(1)}</dd>
                      </div>
                      <div><dt>คะแนนเฉลี่ยรวม</dt><dd>{overallAverage.toFixed(1)}</dd></div>
                      <div><dt>ทีมทั้งหมด</dt><dd>{roomState.data.teams.length}</dd></div>
                    </dl>
                    {roomState.data.status === 'playing' ? (
                      <div className="teacher-answer-progress"><i style={{ width: `${sortedPlayers.length > 0 ? (currentQuestionStats.answeredCount / sortedPlayers.length) * 100 : 0}%` }} /></div>
                    ) : null}
                  </section>
                ) : null}
                <section className="glass-panel p-5">
                  <p className="eyebrow">การควบคุม</p>
                  <div className="mt-4 space-y-3">
                    {roomState.data.status === 'waiting' ? (
                      <>
                        <div className="timer-setting">
                          <label htmlFor="team-count">จำนวนทีม</label>
                          <div>
                            <input id="team-count" type="number" min={1} max={20} step="1" value={teamCountValue} onChange={(event) => setTeamCountValue(event.target.value)} disabled={roomState.data.teamsLocked} />
                          </div>
                          <small>สุ่มทีมได้ซ้ำหลายครั้งจนกว่าจะล็อกทีม</small>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <button className="secondary-button" onClick={() => void randomizeTeams()} disabled={busy || sortedPlayers.length === 0 || !teamCountValid || roomState.data.teamsLocked}>สุ่มทีม</button>
                          <button className={roomState.data.teamsLocked ? 'secondary-button' : 'primary-button'} onClick={() => void toggleTeamLock()} disabled={busy || (!roomState.data.teamsLocked && (roomState.data.teams.length === 0 || unassignedCount > 0))}>
                            {roomState.data.teamsLocked ? 'ปลดล็อกทีม' : 'ล็อกทีม'}
                          </button>
                        </div>
                        {!roomState.data.teamsLocked && roomState.data.teams.length > 0 && unassignedCount > 0 ? (
                          <p className="text-sm text-[#bdb5ac]">มีผู้เล่น {unassignedCount} คนยังไม่ได้จัดทีม กรุณาสุ่มทีมอีกครั้งก่อนล็อก</p>
                        ) : null}
                        <div className="timer-setting">
                          <label htmlFor="question-duration">เวลาต่อคำถาม</label>
                          <div>
                            <input id="question-duration" type="number" min={durationUnit === 'seconds' ? 5 : 1} max={durationUnit === 'seconds' ? 600 : 10} step="1" value={durationValue} onChange={(event) => setDurationValue(event.target.value)} />
                            <select value={durationUnit} onChange={(event) => { const nextUnit = event.target.value as 'seconds' | 'minutes'; setDurationUnit(nextUnit); setDurationValue(nextUnit === 'minutes' ? '1' : '30') }} aria-label="หน่วยเวลา">
                              <option value="seconds">วินาที</option>
                              <option value="minutes">นาที</option>
                            </select>
                          </div>
                          <small>กำหนดได้ตั้งแต่ 5 วินาทีถึง 10 นาที ทุกคนใช้เวลาเท่ากัน</small>
                        </div>
                        <button className="primary-button w-full" onClick={requestStart} disabled={busy || sortedPlayers.length === 0 || !durationValid || !roomState.data.teamsLocked}>
                          {roomState.data.currentRound === 1 ? 'เริ่มภารกิจพร้อมจับเวลา' : 'เริ่มรอบใหม่พร้อมจับเวลา'}
                        </button>
                        {!roomState.data.teamsLocked ? <p className="text-sm text-[#bdb5ac]">ต้องล็อกทีมก่อนจึงจะเริ่มภารกิจได้</p> : null}
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
                  {roomState.data.status === 'waiting' && sortedPlayers.length === 0 ? <p className="mt-3 text-sm text-[#bdb5ac]">ปุ่มเริ่มจะใช้งานได้เมื่อมีอย่างน้อย 1 คนเข้าร่วมและล็อกทีมแล้ว</p> : null}
                </section>
              </aside> : null}
            </div>

            {roomState.data.teams.length > 0 ? (
              <section className="glass-panel mt-6 p-5" aria-label="สถานะมนตรา">
                <p className="eyebrow">สถานะมนตรา</p>
                <h2 className="mt-1 text-xl font-semibold text-[#fff7df]">ไอเทมประจำทีม</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {roomState.data.teams.map((team, index) => {
                    const magic = magicByTeamId.get(team.id)
                    const holderName = magic?.magicHolderPlayerId ? playerNameById.get(magic.magicHolderPlayerId) ?? '-' : '-'
                    const hasShield = magic?.inventory.some((item) => item.itemType === 'rose_shield' && !item.consumed) ?? false
                    const raw = teamStatsById.get(team.id)
                    const competition = competitionStats.find((entry) => entry.id === team.id)
                    return (
                      <div key={team.id} className={`text-sm ${index > 0 ? 'border-t border-white/10 pt-4 sm:border-t-0 sm:pt-0' : ''}`}>
                        <div className="flex items-center justify-between gap-3">
                          <strong className="text-[#fff7df]">{team.name}</strong>
                          <span className="text-xs text-[#c0b7ab]">ผู้ถือคทา: {holderName}</span>
                        </div>
                        <p className="mt-1 text-xs text-[#c0b7ab]">
                          คะแนนดิบเฉลี่ย {(raw?.averageScore ?? 0).toFixed(1)} · คะแนนแข่งขันเฉลี่ย {(competition?.competitionAverage ?? 0).toFixed(1)}
                        </p>
                        <ul className="mt-2 space-y-0.5">
                          {!magic || magic.inventory.length === 0 ? (
                            <li className="text-[#8b8377]">ยังไม่มีไอเทม</li>
                          ) : magic.inventory.map((item, itemIndex) => (
                            <li key={itemIndex} className={item.consumed ? 'text-[#8b8377] line-through' : 'text-[#fff7df]'}>
                              {MAGIC_ITEM_INFO[item.itemType].label}{item.consumed ? ' (ใช้แล้ว)' : ''}
                            </li>
                          ))}
                        </ul>
                        {magic?.queuedEffect ? (
                          <p className="mt-2 text-xs text-[#f2d58d]">
                            กำลังใช้ {MAGIC_ITEM_INFO[magic.queuedEffect.itemType].label} เป้าหมาย {teamNameById.get(magic.queuedEffect.targetTeamId) ?? '-'} · มีผลข้อที่ {magic.queuedEffect.affectedQuestionIndex + 1}
                          </p>
                        ) : null}
                        {hasShield ? <p className="mt-1 text-xs text-[#7fdc9d]">พร้อมป้องกันด้วยเกราะกุหลาบ</p> : null}
                      </div>
                    )
                  })}
                </div>
                {magicEventsState.data.length > 0 ? (
                  <div className="mt-5 border-t border-white/10 pt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[#b6ab9e]">ประวัติล่าสุด</p>
                    <ul className="mt-2 space-y-1 text-xs text-[#c0b7ab]">
                      {magicEventsState.data.slice(0, 8).map((event) => {
                        const statusLabel = {
                          queued: 'รอผล',
                          applied: 'สำเร็จ',
                          blocked: 'ถูกบล็อก',
                          expired: 'หมดอายุ',
                          rejected: 'ถูกปฏิเสธ',
                        }[event.status]
                        return (
                          <li key={event.id}>
                            {teamNameById.get(event.sourceTeamId) ?? event.sourceTeamId} ใช้ {MAGIC_ITEM_INFO[event.itemType].label}
                            {event.targetTeamId && event.targetTeamId !== event.sourceTeamId ? ` → ${teamNameById.get(event.targetTeamId) ?? event.targetTeamId}` : ''}
                            {event.affectedQuestionIndex != null ? ` (ข้อ ${event.affectedQuestionIndex + 1})` : ''}
                            {' — '}{statusLabel}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : null}
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
