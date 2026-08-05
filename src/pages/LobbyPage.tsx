import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BrandHeader, ErrorPanel, LoadingPanel, ScenePage } from '../components/Layout'
import { useRoom, useTeam } from '../hooks/useGameData'
import { resolveStudentRoute } from '../lib/game'
import { getTeamSession } from '../services/sessionStorage'

export const LobbyPage = () => {
  const { roomCode = '' } = useParams()
  const normalizedCode = roomCode.toUpperCase()
  const navigate = useNavigate()
  const session = getTeamSession()
  const roomState = useRoom(normalizedCode)
  const teamState = useTeam(normalizedCode, session?.roomCode === normalizedCode ? session.teamId : '')

  useEffect(() => {
    if (!roomState.data || !teamState.data) return
    const destination = resolveStudentRoute(roomState.data, teamState.data)
    if (destination !== `/lobby/${normalizedCode}`) navigate(destination, { replace: true })
  }, [navigate, normalizedCode, roomState.data, teamState.data])

  return (
    <ScenePage image="/images/hero-curse.png" imageAlt="กุหลาบของมัทนาที่ยังถูกพันธนาการ" imagePosition="50% 58%">
      <BrandHeader />
      <div className="mx-auto flex w-full max-w-4xl flex-1 items-center px-5 py-8 sm:px-8">
        {roomState.loading || teamState.loading ? (
          <LoadingPanel />
        ) : !session || session.roomCode !== normalizedCode ? (
          <ErrorPanel message="ไม่พบข้อมูลกลุ่มบนอุปกรณ์นี้ กรุณาเข้าร่วมห้องอีกครั้ง" action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : !roomState.data ? (
          <ErrorPanel message={roomState.error || 'ไม่พบรหัสห้องนี้'} action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : !teamState.data ? (
          <ErrorPanel message={teamState.error || 'ไม่พบข้อมูลกลุ่มของคุณในห้องนี้'} action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : (
          <section className="lobby-panel w-full text-center" aria-live="polite">
            <p className="eyebrow">ห้อง {normalizedCode} · รอบที่ {roomState.data.currentRound}</p>
            <div className="waiting-rings mx-auto mt-7" aria-hidden="true"><span /><i>ม</i></div>
            <h1 className="mt-7 text-3xl font-semibold sm:text-4xl">รอครูเริ่มภารกิจ</h1>
            <p className="mx-auto mt-3 max-w-md text-[#d8d1c5]">เมื่อประตูเปิด ทุกกลุ่มจะได้รับคำถามข้อแรกพร้อมกัน</p>
            <dl className="lobby-identity mt-7">
              <div><dt>กลุ่ม</dt><dd>{teamState.data.teamName}</dd></div>
              <div><dt>ผู้พิทักษ์</dt><dd>{teamState.data.guardianName}</dd></div>
              <div><dt>รหัสห้อง</dt><dd className="font-mono tracking-[0.15em]">{normalizedCode}</dd></div>
            </dl>
            <div className="mt-7 flex items-center justify-center gap-2 text-sm text-[#c6baa7]"><span className="pulse-dot" aria-hidden="true" />กำลังฟังสัญญาณจากครูแบบ realtime</div>
          </section>
        )}
      </div>
    </ScenePage>
  )
}
