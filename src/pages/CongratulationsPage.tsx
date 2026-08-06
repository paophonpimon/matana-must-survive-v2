import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BrandHeader, ErrorPanel, LoadingPanel, ScenePage } from '../components/Layout'
import { useRoom, usePlayer } from '../hooks/useGameData'
import { formatElapsedTime } from '../lib/game'
import { getPlayerSession } from '../services/sessionStorage'

export const CongratulationsPage = () => {
  const { roomCode = '' } = useParams()
  const normalizedCode = roomCode.toUpperCase()
  const navigate = useNavigate()
  const session = getPlayerSession()
  const roomState = useRoom(normalizedCode)
  // teamId must be read from the live player doc, never cached in session storage — a
  // teacher can re-randomize/unlock teams before lock, which would make a stored teamId stale.
  const playerState = usePlayer(normalizedCode, session?.roomCode === normalizedCode ? session.playerId : '')

  useEffect(() => {
    const room = roomState.data
    if (!room) return
    if (room.status === 'closed') navigate(`/closed/${normalizedCode}`, { replace: true })
    else if (room.status === 'waiting' && session?.roomCode === normalizedCode) navigate(`/lobby/${normalizedCode}`, { replace: true })
  }, [navigate, normalizedCode, roomState.data, session?.roomCode])

  const winner = roomState.data?.winner
  const isWinningTeam = Boolean(winner && session?.roomCode === normalizedCode && playerState.data?.teamId === winner.teamId)

  return (
    <ScenePage image="/images/ending-win.png" imageAlt="มัทนาคืนร่างมนุษย์ท่ามกลางแสงทองและกลีบกุหลาบ" imagePosition="50% 48%">
      <div className="petal-field" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <i key={index} style={{ '--petal': index } as React.CSSProperties} />)}</div>
      <BrandHeader />
      <div className="congratulations-stage">
        {roomState.loading ? <LoadingPanel /> : !roomState.data ? (
          <ErrorPanel message={roomState.error || 'ไม่พบข้อมูลห้องนี้'} action={<Link className="primary-button w-full" to="/">กลับหน้าแรก</Link>} />
        ) : !winner ? (
          <ErrorPanel message="กำลังรอข้อมูลผู้ทำลายคำสาป กรุณารอสักครู่" />
        ) : (
          <section className="congratulations-panel text-center" aria-live="assertive">
            <div className="success-seal mx-auto" aria-hidden="true">✦</div>
            <p className="eyebrow congratulations-eyebrow">คำสาปถูกทำลายแล้ว</p>
            <h1 className="congratulations-title">มัทนาได้รับการช่วยเหลือแล้ว</h1>
            <div className="winner-announcement">
              <p>ขอสดุดีผู้ทำลายคำสาปกลุ่มแรก</p>
              <h2 className="winner-name">กลุ่ม {winner.teamName}</h2>
              <p className="winner-guardian">ผู้พิทักษ์ {winner.guardianName}</p>
            </div>
            <dl className="winner-stats">
              <div><dt>คะแนน</dt><dd>{winner.score}/10</dd></div>
              <div><dt>เวลาที่ใช้</dt><dd>{formatElapsedTime(winner.elapsedMs)}</dd></div>
              <div><dt>หมายเลขรอบ</dt><dd>{winner.round}</dd></div>
            </dl>
            <p className="victory-message">
              {isWinningTeam ? 'กลุ่มของคุณได้เปลี่ยนชะตาของมัทนาสำเร็จ' : 'ภารกิจสิ้นสุดลงแล้ว มัทนาได้รับการช่วยเหลือจากผู้พิทักษ์กลุ่มนี้'}
            </p>
            <div className="winner-wait"><span className="pulse-dot" aria-hidden="true" />รอครูเปิดภารกิจรอบใหม่</div>
          </section>
        )}
      </div>
    </ScenePage>
  )
}
