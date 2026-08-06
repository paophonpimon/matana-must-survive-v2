import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BrandHeader, ErrorPanel, LoadingPanel, ScenePage } from '../components/Layout'
import { MagicPanel } from '../components/MagicPanel'
import { useGame } from '../context/GameContext'
import { useRoom, usePlayer, useTeamMagic, useTeamRoster } from '../hooks/useGameData'
import { resolveStudentRoute } from '../lib/game'
import { getMagicActivationWindow } from '../lib/magic'
import { getPlayerSession } from '../services/sessionStorage'

export const LobbyPage = () => {
  const { roomCode = '' } = useParams()
  const normalizedCode = roomCode.toUpperCase()
  const navigate = useNavigate()
  const { service } = useGame()
  const session = getPlayerSession()
  const roomState = useRoom(normalizedCode)
  const playerState = usePlayer(normalizedCode, session?.roomCode === normalizedCode ? session.playerId : '')
  const teamId = playerState.data?.teamId ?? ''
  const rosterState = useTeamRoster(normalizedCode, teamId)
  const magicState = useTeamMagic(normalizedCode, teamId)

  useEffect(() => {
    if (!roomState.data || !playerState.data) return
    const destination = resolveStudentRoute(roomState.data, playerState.data)
    if (destination !== `/lobby/${normalizedCode}`) navigate(destination, { replace: true })
  }, [navigate, normalizedCode, roomState.data, playerState.data])

  const room = roomState.data
  const player = playerState.data
  const activationWindow = room ? getMagicActivationWindow(room) : { valid: false, affectedQuestionIndex: null }

  return (
    <ScenePage image="/images/hero-curse.png" imageAlt="กุหลาบของมัทนาที่ยังถูกพันธนาการ" imagePosition="50% 58%">
      <BrandHeader />
      <div className="mx-auto flex w-full max-w-4xl flex-1 items-center px-5 py-8 sm:px-8">
        {roomState.loading || playerState.loading ? (
          <LoadingPanel />
        ) : !session || session.roomCode !== normalizedCode ? (
          <ErrorPanel message="ไม่พบข้อมูลผู้เล่นบนอุปกรณ์นี้ กรุณาเข้าร่วมห้องอีกครั้ง" action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : !room ? (
          <ErrorPanel message={roomState.error || 'ไม่พบรหัสห้องนี้'} action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : !player ? (
          <ErrorPanel message={playerState.error || 'ไม่พบข้อมูลผู้เล่นของคุณในห้องนี้'} action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : (
          <div className="w-full">
            <section className="lobby-panel w-full text-center" aria-live="polite">
              <p className="eyebrow">ห้อง {normalizedCode} · รอบที่ {room.currentRound}</p>
              <div className="waiting-rings mx-auto mt-7" aria-hidden="true"><span /><i>ม</i></div>
              <h1 className="mt-7 text-3xl font-semibold sm:text-4xl">รอครูเริ่มภารกิจ</h1>
              <p className="mx-auto mt-3 max-w-md text-[#d8d1c5]">
                {room.teamsLocked ? 'เมื่อประตูเปิด ทุกคนจะได้รับคำถามข้อแรกพร้อมกัน' : 'ครูกำลังจัดทีมให้ทุกคน กรุณารอสักครู่'}
              </p>
              <dl className="lobby-identity mt-7">
                <div><dt>ชื่อผู้เล่น</dt><dd>{player.displayName}</dd></div>
                <div><dt>เลขที่</dt><dd>{player.studentNumber}</dd></div>
                <div><dt>รหัสห้อง</dt><dd className="font-mono tracking-[0.15em]">{normalizedCode}</dd></div>
              </dl>
              <div className="mt-7 flex items-center justify-center gap-2 text-sm text-[#c6baa7]"><span className="pulse-dot" aria-hidden="true" />กำลังฟังสัญญาณจากครูแบบ realtime</div>
            </section>

            <section className="glass-panel mt-5 p-5 text-center" aria-live="polite">
              <p className="eyebrow">ทีมของคุณ</p>
              {!player.teamId ? (
                <p className="mt-2 text-[#d8d1c5]">รอครูจัดทีม</p>
              ) : rosterState.data ? (
                <>
                  <h2 className="mt-2 text-2xl font-semibold text-[#fff7df]">{rosterState.data.teamName}</h2>
                  <p className="mt-1 text-sm text-[#c0b7ab]">สมาชิก {rosterState.data.members.length} คน</p>
                  <p className={`mt-2 text-sm ${room.teamsLocked ? 'text-[#7fdc9d]' : 'text-[#f2d58d]'}`}>
                    {room.teamsLocked ? 'ยืนยันทีมแล้ว' : 'ทีมชั่วคราว — ครูยังสามารถสุ่มใหม่ได้'}
                  </p>
                  <ul className="mt-4 space-y-1 text-left text-sm">
                    {rosterState.data.members.map((member) => (
                      <li key={member.playerId} className="flex items-center justify-between border-t border-white/10 py-1.5">
                        <span>{member.displayName}</span>
                        {member.playerId === player.id ? <span className="text-xs font-semibold text-[#f2d58d]">คุณ</span> : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                // player.teamId has arrived but the roster listener hasn't delivered its first
                // snapshot yet — never show "รอครูจัดทีม" here, that would be wrong: a team
                // *has* been assigned, the roster summary just hasn't synced down yet.
                <p className="mt-2 text-[#c6baa7]">กำลังซิงค์ข้อมูลทีม...</p>
              )}
            </section>

            {player.teamId ? (
              <MagicPanel
                magic={magicState.data}
                magicLoading={magicState.loading}
                teams={room.teams}
                isHolder={magicState.data?.magicHolderPlayerId === player.id}
                canActivateNow={room.status === 'waiting'}
                affectedQuestionIndex={activationWindow.valid ? activationWindow.affectedQuestionIndex : null}
                onChoose={(itemType) => service.chooseStartingItem(normalizedCode, player.teamId as string, player.id, itemType)}
                onActivate={(itemType, targetTeamId) => service.activateItem(normalizedCode, player.teamId as string, player.id, itemType, targetTeamId)}
              />
            ) : null}
          </div>
        )}
      </div>
    </ScenePage>
  )
}
