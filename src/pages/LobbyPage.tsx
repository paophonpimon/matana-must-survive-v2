import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BrandHeader, ErrorPanel, LoadingPanel, ScenePage } from '../components/Layout'
import { MagicPanel } from '../components/MagicPanel'
import { useGame } from '../context/GameContext'
import { useAllTeamGuardianNames, useCaptainVote, useRoom, usePlayer, useTeamCaptainVoteProgress, useTeamMagic, useTeamRoster } from '../hooks/useGameData'
import { resolveStudentRoute } from '../lib/game'
import { TEAM_GUARDIAN_NAME_MAX_LENGTH, TEAM_GUARDIAN_NAME_MIN_LENGTH } from '../lib/teamScoring'
import { friendlyError } from '../services'
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
  const myVoteState = useCaptainVote(normalizedCode, playerState.data?.id ?? '')
  const voteProgressState = useTeamCaptainVoteProgress(normalizedCode, teamId)
  const guardianNamesState = useAllTeamGuardianNames(normalizedCode)
  const [voteBusy, setVoteBusy] = useState(false)
  const [voteError, setVoteError] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const [nameError, setNameError] = useState('')
  const [nameNotice, setNameNotice] = useState('')

  // Milestone 4.1: team captain election. magicHolderPlayerId is null while voting is open —
  // isHolder in MagicPanel already goes false for everyone while it's null, which is what
  // naturally hides chooseStartingItem until a captain exists.
  const captainId = magicState.data?.magicHolderPlayerId ?? null
  const electionAttempt = magicState.data?.captainElectionAttempt ?? 0
  const votedCount = voteProgressState.data.filter((entry) => entry.electionAttempt === electionAttempt).length
  const rosterSize = rosterState.data?.members.length ?? 0
  const myVote = myVoteState.data && myVoteState.data.electionAttempt === electionAttempt ? myVoteState.data.targetPlayerId : null
  // Item 6: guardian team name — captain-editable, teacher-resettable/overridable. teamId is
  // scoped from playerState.data.teamId above, so this always looks up the caller's own team.
  const guardianName = guardianNamesState.data.find((entry) => entry.teamId === teamId)?.name ?? null
  const isCaptain = captainId != null && captainId === playerState.data?.id

  const castVote = async (targetPlayerId: string): Promise<void> => {
    const player = playerState.data
    if (!player || voteBusy) return
    // Friendly pre-check against the already-loaded (broadly-readable) team roster — a student's
    // own player doc read never covers a teammate's, so this can't be re-validated by reading
    // the target's private player doc. Firestore Rules remain the authoritative check on write.
    if (!rosterState.data?.members.some((member) => member.playerId === targetPlayerId)) {
      setVoteError('โหวตได้เฉพาะสมาชิกในทีมของคุณเอง')
      return
    }
    setVoteBusy(true)
    setVoteError('')
    try {
      await service.castCaptainVote(normalizedCode, player.id, targetPlayerId)
    } catch (reason) {
      setVoteError(friendlyError(reason))
    } finally {
      setVoteBusy(false)
    }
  }

  // Item 6: guardian team name — only the finalized captain may submit/edit it (mirrored by
  // firestore.rules' teamNames block, which checks the same magicHolderPlayerId ownership).
  const submitTeamName = async (): Promise<void> => {
    const player = playerState.data
    if (!player || !teamId || nameBusy) return
    setNameBusy(true)
    setNameError('')
    setNameNotice('')
    try {
      await service.setTeamGuardianName(normalizedCode, teamId, player.id, nameDraft)
      setNameDraft('')
      setNameNotice('ตั้งชื่อทีมแล้ว')
    } catch (reason) {
      setNameError(friendlyError(reason))
    } finally {
      setNameBusy(false)
    }
  }

  useEffect(() => {
    if (!roomState.data || !playerState.data) return
    const destination = resolveStudentRoute(roomState.data, playerState.data)
    if (destination !== `/lobby/${normalizedCode}`) navigate(destination, { replace: true })
  }, [navigate, normalizedCode, roomState.data, playerState.data])

  const room = roomState.data
  const player = playerState.data

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
              {/* Stage 'lobby' comes BEFORE Story Recall and before any team exists, so the copy
                  must promise the Recall activity — not the mission/teams, which are still two
                  stages away. Stage 'teamSetup' keeps the original mission-facing copy. */}
              <h1 className="mt-7 text-3xl font-semibold sm:text-4xl">
                {room.phase === 'lobby' ? 'รอเริ่มกู้ความทรงจำ' : 'รอครูเริ่มภารกิจ'}
              </h1>
              <p className="mx-auto mt-3 max-w-md text-[#d8d1c5]">
                {room.phase === 'lobby'
                  ? 'เมื่อทุกคนเข้าห้องพร้อมแล้ว ครูจะเริ่มกิจกรรม'
                  : room.teamsLocked ? 'เมื่อประตูเปิด ทุกคนจะได้รับคำถามข้อแรกพร้อมกัน' : 'ครูกำลังจัดทีมให้ทุกคน กรุณารอสักครู่'}
              </p>
              <dl className="lobby-identity mt-7">
                <div><dt>ชื่อผู้เล่น</dt><dd>{player.displayName}</dd></div>
                <div><dt>เลขที่</dt><dd>{player.studentNumber}</dd></div>
                <div><dt>รหัสห้อง</dt><dd className="font-mono tracking-[0.15em]">{normalizedCode}</dd></div>
              </dl>
              <div className="mt-7 flex items-center justify-center gap-2 text-sm text-[#c6baa7]"><span className="pulse-dot" aria-hidden="true" />กำลังฟังสัญญาณจากครูแบบ realtime</div>
            </section>

            {/* No team exists at all before Story Recall — showing a "ทีมของคุณ / รอครูจัดทีม"
                panel during the pre-Recall lobby would present team assignment as imminent when
                it is actually two stages away. The whole team + magic area only appears once the
                room has reached 'teamSetup'. */}
            {room.phase === 'lobby' ? null : (
            <>
            <section className="glass-panel mt-5 p-5 text-center" aria-live="polite">
              <p className="eyebrow">ทีมของคุณ</p>
              {!player.teamId ? (
                <p className="mt-2 text-[#d8d1c5]">รอครูจัดทีม</p>
              ) : rosterState.data ? (
                <>
                  <h2 className="mt-2 text-2xl font-semibold text-[#fff7df]">{guardianName ?? rosterState.data.teamName}</h2>
                  {guardianName ? <p className="text-xs text-[#8b8377]">{rosterState.data.teamName}</p> : null}
                  <p className="mt-1 text-sm text-[#c0b7ab]">สมาชิก {rosterState.data.members.length} คน</p>
                  <p className={`mt-2 text-sm ${room.teamsLocked ? 'text-[#7fdc9d]' : 'text-[#f2d58d]'}`}>
                    {room.teamsLocked ? 'ยืนยันทีมแล้ว' : 'ทีมชั่วคราว — ครูยังสามารถสุ่มใหม่ได้'}
                  </p>
                  {captainId ? (
                    // Milestone 4.1: the captain announcement, per the exact required text —
                    // stays visible (not a one-time dismissible toast) since "who is captain"
                    // is a stable fact, not a transient event.
                    <div className="mt-4 rounded-xl border border-[#e2bd65]/40 bg-[#3a2a12]/30 p-3 text-left text-sm">
                      <p className="font-semibold text-[#f2d58d]">
                        👑 หัวหน้าทีมของคุณคือ {rosterState.data.members.find((member) => member.playerId === captainId)?.displayName ?? '-'}
                      </p>
                      <p className="mt-1 text-xs text-[#d8d1c5]">ได้รับสิทธิ์ถือคทา เลือกไอเทม และบริหารมนตราของทีม</p>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-[#f2d58d]" aria-live="polite">
                      โหวตแล้ว {votedCount}/{rosterSize} คน
                    </p>
                  )}

                  {/* Item 6: guardian team name — required once a captain is finalized; only
                      the captain may submit/edit it (mirrored by firestore.rules' teamNames
                      block, which checks the same magicHolderPlayerId ownership). */}
                  {captainId ? (
                    <div className="mt-4 rounded-xl border border-[#e2bd65]/40 bg-[#3a2a12]/30 p-3 text-left text-sm">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[#b6ab9e]">ชื่อทีมผู้พิทักษ์</p>
                      {isCaptain ? (
                        <>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              className="team-name-input"
                              placeholder={guardianName ? 'แก้ไขชื่อทีม' : 'ตั้งชื่อทีมของคุณ'}
                              value={nameDraft}
                              maxLength={TEAM_GUARDIAN_NAME_MAX_LENGTH}
                              onChange={(event) => setNameDraft(event.target.value)}
                              aria-label="ตั้งชื่อทีมผู้พิทักษ์"
                            />
                            <button type="button" className="copy-button" onClick={() => void submitTeamName()} disabled={nameBusy || !nameDraft.trim()}>
                              {nameBusy ? 'กำลังบันทึก...' : guardianName ? 'แก้ไข' : 'ยืนยันชื่อทีม'}
                            </button>
                          </div>
                          <small className="mt-1 block text-[#8b8377]">{TEAM_GUARDIAN_NAME_MIN_LENGTH}-{TEAM_GUARDIAN_NAME_MAX_LENGTH} ตัวอักษร ต้องไม่ซ้ำกับทีมอื่นในห้อง</small>
                          {guardianName ? <p className="mt-2 text-[#fff7df]">ชื่อปัจจุบัน: <strong>{guardianName}</strong></p> : null}
                          {nameError ? <p className="error-message mt-2" role="alert">{nameError}</p> : null}
                          {nameNotice && !nameError ? <p className="success-message mt-2" role="status">{nameNotice}</p> : null}
                        </>
                      ) : guardianName ? (
                        <p className="mt-1 text-[#fff7df]">{guardianName}</p>
                      ) : (
                        <p className="mt-1 text-[#c6baa7]">รอหัวหน้าทีมตั้งชื่อทีม</p>
                      )}
                    </div>
                  ) : null}

                  <ul className="mt-4 space-y-1 text-left text-sm">
                    {rosterState.data.members.map((member) => {
                      const isCaptain = member.playerId === captainId
                      const isMyPick = myVote === member.playerId
                      return (
                        <li key={member.playerId} className="flex items-center justify-between gap-3 border-t border-white/10 py-1.5">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{member.displayName}</span>
                            {member.playerId === player.id ? <span className="text-xs font-semibold text-[#f2d58d]">คุณ</span> : null}
                            {isCaptain ? <span className="text-xs font-semibold text-[#f2d58d]" title="หัวหน้าทีม">👑 หัวหน้าทีม</span> : null}
                          </span>
                          {!captainId ? (
                            <button
                              type="button"
                              className={`copy-button ${isMyPick ? 'choice-selected' : ''}`}
                              onClick={() => void castVote(member.playerId)}
                              disabled={voteBusy}
                              aria-pressed={isMyPick}
                            >
                              {isMyPick ? '✓ โหวตแล้ว' : 'โหวต'}
                            </button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                  {voteError ? <p className="error-message mt-3" role="alert">{voteError}</p> : null}
                </>
              ) : (
                // player.teamId has arrived but the roster listener hasn't delivered its first
                // snapshot yet — never show "รอครูจัดทีม" here, that would be wrong: a team
                // *has* been assigned, the roster summary just hasn't synced down yet.
                <p className="mt-2 text-[#c6baa7]">กำลังซิงค์ข้อมูลทีม...</p>
              )}
            </section>

            {player.teamId ? (
              // Milestone 2.2: activation is a status==='playing' concept only — the lobby only
              // ever offers starting-item *selection*, never activation, so canActivateNow is
              // always false here and affectedQuestionIndex is never applicable.
              <MagicPanel
                magic={magicState.data}
                magicLoading={magicState.loading}
                teams={room.teams}
                isHolder={magicState.data?.magicHolderPlayerId === player.id}
                roomStatus={room.status}
                roomCode={normalizedCode}
                currentRound={room.currentRound}
                currentQuestionIndex={room.currentQuestionIndex}
                events={[]}
                canActivateNow={false}
                affectedQuestionIndex={null}
                onChoose={(itemType) => service.chooseStartingItem(normalizedCode, player.teamId as string, player.id, itemType)}
                onActivate={(itemType, targetTeamId) => service.activateItem(normalizedCode, player.teamId as string, player.id, itemType, targetTeamId)}
              />
            ) : null}
            </>
            )}
          </div>
        )}
      </div>
    </ScenePage>
  )
}
