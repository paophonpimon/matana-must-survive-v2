import { useEffect, useMemo } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BrandHeader, ErrorPanel, LoadingPanel, ScenePage } from '../components/Layout'
import { recallQuestionsById } from '../data/recallQuestions'
import { useAllTeamGuardianNames, useRoom, usePlayer, useTeamMagic } from '../hooks/useGameData'
import { computeStudentLearningEvidence } from '../lib/learning'
import { getPlayerSession } from '../services/sessionStorage'
import { DEFAULT_BOSS_QUESTION_DURATION_SECONDS, RECALL_SECONDS_PER_ITEM } from '../types/game'
import type { Player, Room } from '../types/game'

const previewRoom: Room = {
  roomCode: 'PREVIEW',
  status: 'completed',
  currentRound: 1,
  createdAt: 0,
  startedAt: 0,
  completedAt: 0,
  currentQuestionIndex: 9,
  questionDurationSeconds: 30,
  questionStartedAt: null,
  questionClosedAt: null,
  questionIds: [],
  previousQuestionIds: [],
  winner: null,
  teacherSessionId: 'preview-teacher',
  teamCount: 1,
  teamsLocked: true,
  teams: [{ id: 'team-1', name: 'ทีม 1' }],
  phase: 'main',
  recallQuestionDurationSeconds: RECALL_SECONDS_PER_ITEM,
  bossQuestionIds: [],
  bossQuestionIndex: 0,
  bossQuestionStartedAt: null,
  bossQuestionDurationSeconds: DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  bossCompleted: false,
  bossWinner: null,
  bossAwaitingContinue: false,
}

const previewPlayer: Player = {
  id: 'preview-player',
  displayName: 'นักเรียนตัวอย่าง',
  studentNumber: '00',
  teamId: 'team-1',
  joinedAt: 0,
  currentRound: 1,
  currentQuestionIndex: 9,
  score: 0,
  answers: [],
  bossAnswers: [],
  recallAnswers: [],
  submitted: true,
  finishedAt: 0,
  elapsedMs: 0,
  status: 'submitted',
  ownerUid: 'preview-student',
}

export const ResultPage = () => {
  const { roomCode = '' } = useParams()
  const normalizedCode = roomCode.toUpperCase()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const session = getPlayerSession()
  const isPreview = import.meta.env.DEV && searchParams.get('preview') === '1'
  const requestedScore = Number(searchParams.get('score') ?? 0)
  const previewScore = Math.min(10, Math.max(0, Number.isFinite(requestedScore) ? Math.trunc(requestedScore) : 0))
  const roomState = useRoom(isPreview ? '' : normalizedCode)
  const playerState = usePlayer(isPreview ? '' : normalizedCode, !isPreview && session?.roomCode === normalizedCode ? session.playerId : '')
  const room = isPreview ? previewRoom : roomState.data
  const player = isPreview ? previewPlayer : playerState.data
  const assignedTeam = room?.teams.find((team) => team.id === player?.teamId)
  const magicState = useTeamMagic(isPreview ? '' : normalizedCode, isPreview ? '' : (player?.teamId ?? ''))
  const isCaptain = Boolean(player && magicState.data?.magicHolderPlayerId === player.id)
  const guardianNamesState = useAllTeamGuardianNames(isPreview ? '' : normalizedCode)
  const guardianNameById = useMemo(() => new Map(guardianNamesState.data.map((entry) => [entry.teamId, entry.name])), [guardianNamesState.data])
  const assignedTeamDisplayName = assignedTeam ? guardianNameById.get(assignedTeam.id) ?? assignedTeam.name : ''
  // Learning Layer: raw individual correctness only (player.recallAnswers/answers), never
  // magic/team/boss/speed/ranking — see lib/learning.ts's own doc comment for why.
  const learningEvidence = useMemo(() => (player ? computeStudentLearningEvidence(player) : null), [player])

  useEffect(() => {
    if (!room || !player) return
    if (room.status === 'closed') navigate(`/closed/${normalizedCode}`, { replace: true })
    else if (room.winner) navigate(`/congratulations/${normalizedCode}`, { replace: true })
    else if (room.status === 'waiting') navigate(`/lobby/${normalizedCode}`, { replace: true })
    else if (room.status === 'playing' && !player.submitted) navigate(`/game/${normalizedCode}`, { replace: true })
  }, [navigate, normalizedCode, room, player])

  const score = isPreview ? previewScore : player?.score ?? 0
  const failed = score <= 4
  const successful = score >= 9
  const image = failed ? '/images/ending-fail.png' : successful ? '/images/ending-win.png' : '/images/ending-almost.png'
  const title = failed ? 'ภารกิจล้มเหลว' : successful ? 'ภารกิจสำเร็จ!' : 'เกือบสำเร็จแล้ว!'
  const resultPanelClass = successful
    ? 'congratulations-panel result-panel success-result-panel'
    : `result-panel character-result-panel ${failed ? 'result-outcome-fail' : 'result-outcome-almost'} w-full p-6 sm:p-9`

  return (
    <ScenePage image={image} imageAlt={failed ? 'ดอกกุหลาบที่ถูกคำสาปครอบงำ' : successful ? 'มัทนาคืนร่างมนุษย์ท่ามกลางแสงทอง' : 'กุหลาบของมัทนาที่คำสาปเริ่มอ่อนกำลัง'} imagePosition={successful ? '50% 48%' : '50% 54%'}>
      <BrandHeader />
      <div className={successful ? 'congratulations-stage' : 'mx-auto flex w-full max-w-4xl flex-1 items-end px-5 pb-8 pt-20 sm:items-center sm:px-8 sm:py-12'}>
        {!isPreview && (roomState.loading || playerState.loading) ? <LoadingPanel /> : !room || !player ? (
          <ErrorPanel message={roomState.error || playerState.error || 'ไม่พบข้อมูลผลลัพธ์ของคุณ'} action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : (
          <section className={resultPanelClass}>
            <div className={successful ? 'result-hero result-hero-success' : 'result-hero'}>
              <div className="result-hero-copy">
                {/* Identity: the STUDENT's own name leads, on its own line and at display size.
                    Team and captain are secondary badges beneath it, and the round is small
                    trailing metadata — so the team name can never be mistaken for the student's
                    name the way it was when all three shared one dense line. Items are
                    deliberately absent here: they matter during Main/Boss, not on the result. */}
                <div className="result-identity">
                  <strong className="result-identity-name">{player.displayName}</strong>
                  <span className="result-identity-badges">
                    {assignedTeamDisplayName ? <span className="result-identity-team">ทีม {assignedTeamDisplayName}</span> : null}
                    {isCaptain ? <span className="result-identity-captain" title="หัวหน้าทีม">👑 หัวหน้าทีม</span> : null}
                    <span className="result-identity-round">รอบที่ {room.currentRound}</span>
                  </span>
                </div>
                <h1 className="result-title mt-4">{title}</h1>
                {failed ? (
                  <p className="result-description mt-4"><span>คุณตอบคำถามผิดมากเกินไป</span><span>การตัดสินใจของคุณทำให้มัทนาถูกสาป</span><span>เป็นดอกกุหลาบไปตลอดกาล</span><span>หนทางกลับคืนสู่ร่างมนุษย์ของนางได้ปิดลงแล้ว...</span></p>
                ) : successful ? (
                  <p className="result-description mt-4"><span>คุณช่วยทำลายคำสาปได้สำเร็จ</span><span>ความรู้ของผู้พิทักษ์ช่วยให้มัทนากลับคืนสู่ร่างมนุษย์</span><span>นี่คือคะแนนของคุณเมื่อหมดเวลารอบนี้</span></p>
                ) : (
                  <p className="result-description mt-4"><span>พลังคำสาปอ่อนลง</span><span>แต่ความรู้ของผู้พิทักษ์ยังไม่เพียงพอ</span><span>มัทนายังคงติดอยู่ในร่างดอกกุหลาบ</span><span>พยายามอีกนิด แล้วกลับมาช่วยนางในรอบต่อไป</span></p>
                )}
              </div>
              {!successful && (
                <div className="result-icon-stage">
                  <span className="result-icon-halo" aria-hidden="true" />
                  <img
                    className="result-ending-icon"
                    src={failed ? '/images/ending-fail-icon.png' : '/images/ending-almost-icon.png'}
                    alt={failed ? 'ภาพมัทนาในผลภารกิจล้มเหลว' : 'ภาพมัทนาในผลภารกิจเกือบสำเร็จ'}
                    draggable="false"
                    onError={(event) => { event.currentTarget.parentElement?.classList.add('image-failed') }}
                  />
                </div>
              )}
            </div>
            {/* Item 6 (follow-up): the boss/item-challenge winner announcement is an in-game
                event, not part of the final-result presentation — removed from here. Boss data
                (room.bossWinner/bossCompleted) stays persisted for logs/history; this screen
                simply no longer renders it. Final result stays focused on the 10 main
                questions' knowledge score only. */}
            <div className="score-reveal mt-6"><small>คะแนนความรู้</small><strong>{score * 10}<span>/100</span></strong><small>{score} จาก 10 ข้อ</small></div>

            {/* Learning Layer: appended below the existing competitive result, never replacing
                it. Shown for every real (non-preview) result — preview mode has no real recall
                data to summarize. */}
            {!isPreview && learningEvidence ? (
              <section className="learning-summary mt-6" aria-label="สรุปการเรียนรู้ของคุณ">
                <p className="eyebrow">สรุปการเรียนรู้</p>
                {/* Plain before/after counts out of 5. The old "+40% / -40%" figure was a
                    percentage-point difference between two 5-item scores, which reads as a grade
                    and confuses more than it explains — the counts plus a sentence say the same
                    thing in classroom language. */}
                <dl className="learning-summary-grid mt-2">
                  <div><dt>ก่อนเล่น</dt><dd>{learningEvidence.recallCorrectCount}/5</dd></div>
                  <div><dt>หลังเล่น</dt><dd>{learningEvidence.mainEvidenceCorrectCount}/5</dd></div>
                </dl>
                <p className={`learning-summary-verdict ${learningEvidence.mainEvidenceCorrectCount > learningEvidence.recallCorrectCount ? 'learning-summary-verdict-up' : learningEvidence.mainEvidenceCorrectCount < learningEvidence.recallCorrectCount ? 'learning-summary-verdict-down' : ''}`}>
                  {learningEvidence.mainEvidenceCorrectCount > learningEvidence.recallCorrectCount
                    ? `เข้าใจเพิ่มขึ้น ${learningEvidence.mainEvidenceCorrectCount - learningEvidence.recallCorrectCount} เรื่อง`
                    : learningEvidence.mainEvidenceCorrectCount < learningEvidence.recallCorrectCount
                      ? `ควรทบทวนเพิ่ม ${learningEvidence.recallCorrectCount - learningEvidence.mainEvidenceCorrectCount} เรื่อง`
                      : 'ผลการเรียนรู้คงเดิม'}
                </p>
                {learningEvidence.improvedConceptIds.length > 0 ? (
                  <p className="learning-summary-note learning-summary-note-positive">
                    เข้าใจเพิ่มขึ้น: {learningEvidence.improvedConceptIds.map((id) => recallQuestionsById.get(id)?.label ?? id).join(', ')}
                  </p>
                ) : null}
                {learningEvidence.stillIncorrectConceptIds.length > 0 ? (
                  <p className="learning-summary-note">
                    ควรทบทวน: {learningEvidence.stillIncorrectConceptIds.map((id) => recallQuestionsById.get(id)?.label ?? id).join(', ')}
                  </p>
                ) : null}
              </section>
            ) : null}

            <div className="waiting-banner mt-6"><span className="pulse-dot" aria-hidden="true" /><span><strong>โปรดรอครูเปิดภารกิจรอบใหม่</strong><small>หน้านี้จะแสดงเฉพาะคะแนนของคุณ และเปลี่ยนอัตโนมัติเมื่อครูเตรียมรอบใหม่</small></span></div>
            <button className="secondary-button mt-4 w-full" type="button" disabled>รอครูเปิดภารกิจรอบใหม่</button>
          </section>
        )}
      </div>
    </ScenePage>
  )
}
