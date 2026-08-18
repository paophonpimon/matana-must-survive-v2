import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { BossResultDetails } from '../components/BossResultDetails'
import { ErrorPanel, LoadingPanel, ScenePage } from '../components/Layout'
import { MagicItemIcon } from '../components/MagicItemIcon'
import { MagicPanel } from '../components/MagicPanel'
import { TeamItemStatus } from '../components/TeamItemStatus'
import { PhaseIntro, type PhaseIntroKey } from '../components/PhaseIntro'
import { PostTestPhase } from '../components/PostTestPhase'
import { SurveyPhase } from '../components/SurveyPhase'
import { PreTestPhase } from '../components/PreTestPhase'
import { RecallPhase } from '../components/RecallPhase'
import { useGame } from '../context/GameContext'
import { questionsById } from '../data/questions'
import { useAllTeamGuardianNames, useRoom, usePlayer, useTeamAnswerProgress, useMagicEvents, useTeamMagic, useTeamRoster } from '../hooks/useGameData'
import { shuffleChoicesForPlayer } from '../lib/choiceOrder'
import { resolveStudentRoute } from '../lib/game'
import { areAnswersLocked, bossQuestionTiming, getQuestionDeadline, getRemainingMilliseconds, getRevealRemainingMilliseconds, mainQuestionTiming } from '../lib/gameFlow'
import { BOSS_REVEAL_MILLISECONDS } from '../lib/boss'
import { buildScoreSealCopy, getMagicActivationWindow, MAGIC_ITEM_INFO } from '../lib/magic'
import { friendlyError } from '../services'
import { getPlayerSession, hasShownBossWinnerBanner, markBossWinnerBannerShown } from '../services/sessionStorage'
import type { BossWinner } from '../types/game'

const formatCountdown = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const formatMultiplier = (multiplier: number): string => {
  if (multiplier === 1) return '×1'
  return Number.isInteger(multiplier) ? `×${multiplier}` : `×${multiplier.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`
}

export const GamePage = () => {
  const { roomCode = '' } = useParams()
  const normalizedCode = roomCode.toUpperCase()
  const navigate = useNavigate()
  const { service } = useGame()
  const session = getPlayerSession()
  const roomState = useRoom(normalizedCode)
  const playerState = usePlayer(normalizedCode, session?.roomCode === normalizedCode ? session.playerId : '')
  const teamId = playerState.data?.teamId ?? ''
  const rosterState = useTeamRoster(normalizedCode, teamId)
  const progressState = useTeamAnswerProgress(normalizedCode, teamId)
  const magicState = useTeamMagic(normalizedCode, teamId)
  const magicEventsState = useMagicEvents(normalizedCode)
  const guardianNamesState = useAllTeamGuardianNames(normalizedCode)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingChoiceId, setPendingChoiceId] = useState('')
  const [bossSwipeOffset, setBossSwipeOffset] = useState(0)
  const bossSwipeStartX = useRef<number | null>(null)
  const [now, setNow] = useState(Date.now())

  const room = roomState.data
  const player = playerState.data
  const assignedTeam = room?.teams.find((team) => team.id === player?.teamId)
  // Item 6: guardian name (once set) replaces the generic "ทีม N" label everywhere on this
  // screen — displayTeams is what's passed to MagicPanel so its target-team select and queued-
  // effect text pick up guardian names automatically, without changing MagicPanel itself.
  const guardianNameById = useMemo(() => new Map(guardianNamesState.data.map((entry) => [entry.teamId, entry.name])), [guardianNamesState.data])
  const displayTeams = useMemo(() => (room?.teams ?? []).map((team) => ({ ...team, name: guardianNameById.get(team.id) ?? team.name })), [room?.teams, guardianNameById])
  const assignedTeamDisplayName = assignedTeam ? guardianNameById.get(assignedTeam.id) ?? assignedTeam.name : 'ยังไม่ได้จัดทีม'
  const isBossPhase = room?.phase === 'boss'
  // Intro plays on entry to a MAJOR activity only. teamSetup lives on the lobby and result on the
  // result page, so this page covers the six phases it actually renders.
  const introPhase: PhaseIntroKey | null = room && ['preTest', 'recall', 'main', 'boss', 'postTest', 'survey'].includes(room.phase)
    ? (room.phase as PhaseIntroKey)
    : null
  const questionIndex = room?.currentQuestionIndex ?? 0
  const questionId = room?.questionIds[questionIndex]
  const question = questionId ? questionsById.get(questionId) : undefined
  const savedAnswer = player?.answers.find((answer) => answer.questionId === questionId)
  const selectedChoiceId = pendingChoiceId || savedAnswer?.selectedChoiceId || ''
  const mainTiming = room ? mainQuestionTiming(room) : null
  const remainingMs = mainTiming && !isBossPhase ? getRemainingMilliseconds(mainTiming, now) : 0
  const revealRemainingMs = mainTiming && !isBossPhase ? getRevealRemainingMilliseconds(mainTiming, now) : 0
  const timeExpired = remainingMs <= 0
  const hasAnswered = Boolean(savedAnswer || pendingChoiceId)
  const answerWasCorrect = Boolean(selectedChoiceId && selectedChoiceId === question?.correctChoiceId)
  const progress = Math.min(100, (questionIndex / 10) * 100)
  const knowledgeScore100 = (player?.score ?? 0) * 10

  // ศึกด่านชิงมนตรา (Milestone 4): reuses the SAME gameFlow.ts timer helpers as the main flow,
  // fed a boss-shaped {questionStartedAt, questionDurationSeconds, questionClosedAt: null}
  // object — boss has no early-close, so questionClosedAt is always null here.
  const bossTiming = room ? bossQuestionTiming(room) : null
  const bossRemainingMs = bossTiming ? getRemainingMilliseconds(bossTiming, now) : 0
  const bossDeadline = bossTiming ? getQuestionDeadline(bossTiming) : null
  const bossRevealRemainingMs = bossDeadline != null && now >= bossDeadline
    ? Math.max(0, bossDeadline + BOSS_REVEAL_MILLISECONDS - now)
    : 0
  const bossTimeExpired = bossRemainingMs <= 0
  const bossQuestionId = room?.bossQuestionIds[room.bossQuestionIndex]
  const bossQuestion = bossQuestionId ? questionsById.get(bossQuestionId) : undefined
  const bossSavedAnswer = player?.bossAnswers.find((answer) => answer.questionId === bossQuestionId)
  // Boss choices shuffle too, EXCEPT for the swipe interaction: there, left and right are bound to
  // specific choice ids by the question itself (swipeLeftChoiceId / swipeRightChoiceId), so
  // position carries meaning and reordering would change what a swipe does. Icon-based kinds are
  // safe because choiceIcons is keyed by choice id and travels with the choice.
  const bossOrderedChoices = useMemo(() => {
    if (!bossQuestion) return []
    if (bossQuestion.bossInteraction?.kind === 'swipe') return bossQuestion.choices
    return shuffleChoicesForPlayer(bossQuestion.choices, player?.id ?? '', bossQuestion.id)
  }, [bossQuestion, player?.id])
  const bossSelectedChoiceId = pendingChoiceId || bossSavedAnswer?.selectedChoiceId || ''
  const bossHasAnswered = Boolean(bossSavedAnswer || pendingChoiceId)

  // Y is the full locked roster (disconnected members included, since it's membership-based
  // not connection-based); X counts progress entries for the room's *current* questionId AND
  // currentRound only — a teammate's entry for a previous question simply doesn't match, so
  // this reads 0 for a fresh question with no explicit reset, and holds steady through the
  // reveal window since nothing touches these entries between question-end and the next
  // question actually starting. The round check (Milestone 2.1) matters because this
  // collection is never wiped on a round transition — without it, a stale entry from an
  // earlier round would misreport as "already answered" if a later round's question happens
  // to reuse the same questionId.
  const teamRosterSize = rosterState.data?.members.length ?? 0
  const teamAnsweredCount = room && questionId
    ? progressState.data.filter((entry) => entry.questionId === questionId && entry.currentRound === room.currentRound).length
    : 0
  // Milestone 2.2/4: activation is available for the whole lifecycle of the current question
  // (answering or reveal) — no longer gated on timeExpired/revealRemainingMs. getMagicActivationWindow
  // is deliberately boss-phase-unaware (see lib/magic.ts), so phase === 'main' is checked here too.
  const activationWindow = room ? getMagicActivationWindow(room) : { valid: false, affectedQuestionIndex: null }
  const canActivateMagicNow = activationWindow.valid && room?.phase === 'main'

  // Milestone 4 section 3: the post-reveal raw/magic/competition breakdown for the question
  // that JUST resolved — persisted server-side onto the team's magic doc (see
  // TeamMagicBreakdown's doc comment in types/game.ts for why students can't compute this
  // themselves). Shown only while it actually matches the question that just closed.
  const breakdown = magicState.data?.lastResolvedBreakdown
  const showBreakdown = Boolean(!isBossPhase && breakdown && breakdown.questionIndex === questionIndex && timeExpired)

  // Illusion hides exactly TWO incorrect choices for every member of the holder's team on the
  // question it targets — never boss questions (illusion's queuedEffect can only ever target a
  // main questionIds index in the first place). The hidden choices were chosen once, service-side,
  // at activation time (see hiddenChoiceIds' doc comment in types/game.ts) — this only ever READS
  // them, never recomputes them, so a refresh or reconnect cannot reroll them.
  const illusionEffect = magicState.data?.queuedEffect
  // Memoised so the array identity is stable across renders — it feeds the visibleChoices memo,
  // which must not recompute (and so must not reshuffle) on every render.
  const illusionHiddenChoiceIds = useMemo(
    () => (!isBossPhase && illusionEffect?.itemType === 'illusion' && illusionEffect.affectedQuestionIndex === questionIndex
      ? illusionEffect.hiddenChoiceIds ?? []
      : []),
    [isBossPhase, illusionEffect, questionIndex],
  )
  // Illusion removes choices BY ID, before ordering — so the removed pair is identical for every
  // member of the team regardless of the order each of them sees, and can never be "the third
  // button" for one student and a different choice for another.
  const visibleChoices = useMemo(
    () => shuffleChoicesForPlayer(
      question ? question.choices.filter((choice) => !illusionHiddenChoiceIds.includes(choice.id)) : [],
      player?.id ?? '',
      question?.id ?? '',
    ),
    [question, illusionHiddenChoiceIds, player?.id],
  )

  // Visual-only: is an item effect landing on the question currently on screen? Derived entirely
  // from the existing magic state — the team's own queuedEffect for buffs, and the same
  // magicEvents-backed incoming-seal data the panel below already reads for hostile effects.
  // Scoped to `affectedQuestionIndex === questionIndex`, so the highlight appears only while the
  // effect is genuinely active on this question and clears itself the moment the room advances.
  const ownActiveEffect = !isBossPhase
    && magicState.data?.queuedEffect
    && magicState.data.queuedEffect.affectedQuestionIndex === questionIndex
    && magicState.data.queuedEffect.targetTeamId === player?.teamId
    ? magicState.data.queuedEffect
    : null
  const incomingSealCount = useMemo(() => {
    if (isBossPhase || !room || !player?.teamId) return 0
    return magicEventsState.data.filter((event) => (
      event.round === room.currentRound
      && event.status === 'queued'
      && event.itemType === 'score_seal'
      && event.targetTeamId === player.teamId
      && event.affectedQuestionIndex === questionIndex
    )).length
  }, [isBossPhase, room, player?.teamId, magicEventsState.data, questionIndex])
  // A hostile effect takes visual precedence: "your points are being halved" is the more urgent
  // thing for a student to notice than their own buff.
  const activeEffectKind = incomingSealCount > 0
    ? 'seal'
    : ownActiveEffect?.itemType === 'power_surge'
      ? 'surge'
      : ownActiveEffect?.itemType === 'illusion'
        ? 'illusion'
        : null
  const isCaptain = Boolean(player && magicState.data?.magicHolderPlayerId === player.id)

  useEffect(() => {
    if (room?.status !== 'playing') return
    setNow(Date.now())
    const intervalId = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(intervalId)
  }, [room?.status, room?.questionStartedAt, room?.bossQuestionStartedAt])

  useEffect(() => {
    setPendingChoiceId('')
    setBossSwipeOffset(0)
    bossSwipeStartX.current = null
    setError('')
    setSaving(false)
  }, [questionId, bossQuestionId])

  // Milestone 4: "announce the winner and reward on every screen" — a one-time banner shown to
  // every student the moment the boss phase resolves, deduped per round via sessionStorage so
  // it never reappears on a same-tab refresh (see services/sessionStorage.ts).
  const [bossWinnerBanner, setBossWinnerBanner] = useState<BossWinner | null>(null)
  useEffect(() => {
    if (!room?.bossCompleted || !room.bossWinner) return
    if (hasShownBossWinnerBanner(normalizedCode, room.currentRound)) return
    markBossWinnerBannerShown(normalizedCode, room.currentRound)
    setBossWinnerBanner(room.bossWinner)
    const timeoutId = window.setTimeout(() => setBossWinnerBanner(null), 6_000)
    return () => window.clearTimeout(timeoutId)
  }, [room?.bossCompleted, room?.bossWinner, room?.currentRound, normalizedCode])

  // Single source of truth: resolveStudentRoute owns every stage->screen decision, so this page
  // and LobbyPage can never disagree about where a student belongs. In particular it is what
  // keeps a student on this page during 'recall' (which runs while status is still 'waiting')
  // instead of bouncing them back to the lobby.
  useEffect(() => {
    if (!room || !player) return
    const destination = resolveStudentRoute(room, player)
    if (destination !== `/game/${normalizedCode}`) navigate(destination, { replace: true })
  }, [navigate, normalizedCode, room, player])

  const categoryLabel = useMemo(() => {
    const labels = { basic: 'พื้นฐานเรื่อง', characters: 'ตัวละคร', plot: 'เนื้อเรื่อง', poetry: 'วรรณศิลป์', theme: 'แก่นเรื่อง' }
    return question ? labels[question.category] : ''
  }, [question])

  const bossCategoryLabel = useMemo(() => {
    const labels = { basic: 'พื้นฐานเรื่อง', characters: 'ตัวละคร', plot: 'เนื้อเรื่อง', poetry: 'วรรณศิลป์', theme: 'แก่นเรื่อง' }
    return bossQuestion ? labels[bossQuestion.category] : ''
  }, [bossQuestion])

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

  const answerBossQuestion = async (choiceId: string): Promise<void> => {
    // Rapid Boss is first-action-locked: speed is part of the ranking, so unlike main questions
    // there is no answer-changing window. pendingChoiceId makes the lock immediate on tap/swipe,
    // before the Firestore write even returns.
    if (!room || !player || !bossQuestion || areAnswersLocked(saving, bossTimeExpired) || bossHasAnswered) return
    setSaving(true)
    setError('')
    setPendingChoiceId(choiceId)
    try {
      await service.saveBossAnswer(normalizedCode, player.id, {
        questionId: bossQuestion.id,
        selectedChoiceId: choiceId,
        expectedBossIndex: room.bossQuestionIndex,
      })
    } catch (reason) {
      setError(friendlyError(reason))
      setPendingChoiceId('')
    } finally {
      setSaving(false)
    }
  }

  const handleBossSwipeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (areAnswersLocked(saving, bossTimeExpired) || bossHasAnswered) return
    bossSwipeStartX.current = event.clientX
    event.currentTarget.setPointerCapture(event.pointerId)
    setBossSwipeOffset(0)
  }

  const handleBossSwipeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (bossSwipeStartX.current == null || bossHasAnswered) return
    setBossSwipeOffset(Math.max(-110, Math.min(110, event.clientX - bossSwipeStartX.current)))
  }

  const handleBossSwipeEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (bossSwipeStartX.current == null || !bossQuestion?.bossInteraction || bossHasAnswered) return
    const deltaX = event.clientX - bossSwipeStartX.current
    bossSwipeStartX.current = null
    setBossSwipeOffset(0)
    if (Math.abs(deltaX) < 48) return
    const choiceId = deltaX < 0
      ? bossQuestion.bossInteraction.swipeLeftChoiceId
      : bossQuestion.bossInteraction.swipeRightChoiceId
    if (choiceId) void answerBossQuestion(choiceId)
  }

  return (
    <ScenePage compact>
      <PhaseIntro phase={introPhase} entryKey={`${normalizedCode}-${room?.currentRound ?? 0}`} />
      {bossWinnerBanner ? (
        <div className="magic-toast-stack" aria-live="assertive">
          <div className="magic-toast magic-toast-winner">
            <span className="magic-toast-icon-wrap" aria-hidden="true">
              <span className="magic-toast-glow" />
              <MagicItemIcon itemType={bossWinnerBanner.rewardItemType} size="lg" />
            </span>
            <div className="magic-toast-copy">
              <strong className="magic-toast-headline">🏆 ผู้พิชิตด่านชิงมนตรา</strong>
              <p>
                {`${bossWinnerBanner.displayName} จากทีม${bossWinnerBanner.teamId ? guardianNameById.get(bossWinnerBanner.teamId) ?? bossWinnerBanner.teamName ?? '' : bossWinnerBanner.teamName ?? ''}\nตอบถูก ${bossWinnerBanner.correctCount}/3 ใช้เวลา ${(bossWinnerBanner.totalTimeMs / 1_000).toFixed(2)} วินาที\nทีมได้รับ ${MAGIC_ITEM_INFO[bossWinnerBanner.rewardItemType].label}เพิ่ม 1 ครั้ง`}
              </p>
            </div>
          </div>
        </div>
      ) : null}
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-7">
        {roomState.loading || playerState.loading ? (
          <LoadingPanel text="กำลังนำคำถามกลับมา..." />
        ) : !session || session.roomCode !== normalizedCode ? (
          <ErrorPanel message="ไม่พบข้อมูลผู้เล่นบนอุปกรณ์นี้" action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : !room || !player ? (
          <ErrorPanel message={roomState.error || playerState.error || 'ไม่พบข้อมูลห้องหรือข้อมูลผู้เล่นของคุณ'} action={<Link className="primary-button w-full" to="/join">กลับหน้าเข้าร่วม</Link>} />
        ) : room.status === 'completed' ? (
          <LoadingPanel text="กำลังสรุปคะแนน..." />
        ) : room.phase === 'survey' ? (
          // Final individual step: an opinion survey. No score, no correctness, no ranking.
          <SurveyPhase
            player={player}
            onRespond={(input) => service.saveSurveyResponse(normalizedCode, player.id, input)}
          />
        ) : room.phase === 'postTest' ? (
          // Assessment Layer: individual, self-paced post-test. Runs after Main with the room
          // still 'playing'; the Main score is already final and is neither read nor written here.
          <PostTestPhase
            player={player}
            room={room}
            onAnswer={(input) => service.savePostTestAnswer(normalizedCode, player.id, input)}
            onTimeout={(expectedIndex) => service.advancePostTestQuestion(normalizedCode, player.id, expectedIndex)}
          />
        ) : room.phase === 'preTest' ? (
          // Assessment Layer: individual, self-paced pre-test. Rendered inside the existing game
          // shell so routing/session handling stay identical to every other phase.
          <PreTestPhase
            player={player}
            room={room}
            onAnswer={(input) => service.savePreTestAnswer(normalizedCode, player.id, input)}
            onTimeout={(expectedIndex) => service.advancePreTestQuestion(normalizedCode, player.id, expectedIndex)}
          />
        ) : room.phase === 'recall' ? (
          // Learning Layer: mandatory individual "ทบทวนเรื่องราว" phase, before Main's timer
          // ever starts — fully self-contained (own progress model, no team/magic UI at all).
          <RecallPhase
            player={player}
            room={room}
            onAnswer={(input) => service.saveRecallAnswer(normalizedCode, player.id, input)}
          />
        ) : isBossPhase ? (
          // Item 5: once the 3rd boss question resolves, phase deliberately stays 'boss' until
          // the teacher presses "เล่นต่อ" (continueAfterBoss) — this branch is what stops every
          // client from entering the next question early, replacing the by-then-expired boss
          // question form with an explicit waiting state instead of a stale/frozen one.
          // Item 6 follow-up: the popup modal is gone — this same waiting screen now IS the
          // result screen (winner/team/stats/reward via the shared BossResultDetails, same
          // content the teacher sees), not just a "please wait" placeholder. A refresh/reconnect
          // lands right back here for free, since it's driven by the normal realtime room
          // subscription like everything else on this page — no separate modal-open state to
          // restore. Falls back to the plain waiting message on the rare tie/no-winner case
          // (room.bossWinner null) where there is nothing to show yet.
          room.bossAwaitingContinue ? (
            <div className="boss-awaiting-continue" aria-live="polite">
              {room.bossWinner ? (
                <>
                  <p className="eyebrow">🏆 ผู้พิชิตด่านชิงมนตรา</p>
                  <h1 className="mt-2 text-center text-2xl font-semibold sm:text-3xl">ศึกด่านชิงมนตราจบแล้ว!</h1>
                  <BossResultDetails
                    winner={room.bossWinner}
                    guardianTeamName={room.bossWinner.teamId ? guardianNameById.get(room.bossWinner.teamId) ?? room.bossWinner.teamName ?? '-' : room.bossWinner.teamName ?? '-'}
                  />
                </>
              ) : (
                // No-winner case — nobody answered a single boss question correctly, so no team
                // was awarded an item this round.
                <>
                  <div className="waiting-rings mx-auto" aria-hidden="true"><span /><i>ม</i></div>
                  <h1 className="mt-6 text-center text-2xl font-semibold sm:text-3xl">ศึกด่านชิงมนตราจบแล้ว!</h1>
                  <p className="mx-auto mt-2 max-w-md text-center text-[#d8d1c5]">ไม่มีผู้พิชิตด่านในรอบนี้ — ไม่มีทีมใดได้รับไอเทม</p>
                </>
              )}
              <p className="mx-auto mt-3 max-w-md text-center text-[#d8d1c5]">รอครูประกาศผลและกด &quot;เล่นต่อ&quot; เพื่อดำเนินภารกิจต่อ</p>
            </div>
          ) : !bossQuestion ? (
            <LoadingPanel text="กำลังเรียกด่านชิงมนตรา..." />
          ) : (
            <>
              <header className="game-header">
                <div className="min-w-0">
                  <p className="text-xs text-[#aaa298]">ผู้เล่น</p>
                  <strong className="block truncate text-[#fff7df]">{player.displayName}</strong>
                  <small className="block truncate text-[#c0b7ab]">{assignedTeamDisplayName}</small>
                  <TeamItemStatus inventory={magicState.data?.inventory} className="mt-1" />
                </div>
                <div className="text-right"><p className="text-xs text-[#aaa298]">ศึกด่านชิงมนตรา</p><strong className={`question-timer ${bossRemainingMs <= 3_000 ? 'question-timer-urgent' : ''}`}>{bossTimeExpired ? 'หมดเวลา' : formatCountdown(bossRemainingMs)}</strong></div>
              </header>

              <section className="mt-4" aria-label={`ด่านชิงมนตรา ข้อ ${room.bossQuestionIndex + 1} จาก 3 ข้อ`}>
                <div className="mb-2 flex justify-between text-sm"><span className="text-[#f2d58d]">✦ ศึกด่านชิงมนตรา — ข้อที่ {room.bossQuestionIndex + 1} จาก 3</span><span className="text-[#c9a55f]">ไม่กระทบคะแนนความรู้</span></div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${((room.bossQuestionIndex + 1) / 3) * 100}%` }} /></div>
              </section>

              <section className={`question-card boss-rapid-card mt-5 ${bossHasAnswered ? 'answer-saved' : ''}`}>
                <div className="flex items-center justify-between gap-3"><span className="category-chip">{bossCategoryLabel}</span><span className="text-sm text-[#aaa298]">ตอบครั้งเดียว • เน้นความไว</span></div>
                <p className="boss-rapid-step">{bossQuestion.bossInteraction?.title ?? `จังหวะที่ ${room.bossQuestionIndex + 1}`}</p>
                <blockquote className="boss-source-quote">{bossQuestion.question}</blockquote>
                {bossQuestion.bossInteraction?.question ? (
                  <p className="boss-rapid-question">{bossQuestion.bossInteraction.question}</p>
                ) : null}
                <p className="boss-rapid-instruction">{bossQuestion.bossInteraction?.instruction ?? 'เลือกคำตอบ'}</p>

                {bossQuestion.bossInteraction?.kind === 'swipe' ? (() => {
                  const leftChoice = bossQuestion.choices.find((choice) => choice.id === bossQuestion.bossInteraction?.swipeLeftChoiceId)
                  const rightChoice = bossQuestion.choices.find((choice) => choice.id === bossQuestion.bossInteraction?.swipeRightChoiceId)
                  return (
                    <div className="boss-swipe-zone">
                      <div
                        className={`boss-swipe-card ${bossHasAnswered ? 'boss-swipe-card-locked' : ''}`}
                        role="button"
                        tabIndex={bossHasAnswered || bossTimeExpired ? -1 : 0}
                        aria-label="ปัดซ้ายหรือขวาเพื่อตอบ"
                        onPointerDown={handleBossSwipeStart}
                        onPointerMove={handleBossSwipeMove}
                        onPointerUp={handleBossSwipeEnd}
                        onPointerCancel={() => { bossSwipeStartX.current = null; setBossSwipeOffset(0) }}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowLeft' && leftChoice) void answerBossQuestion(leftChoice.id)
                          if (event.key === 'ArrowRight' && rightChoice) void answerBossQuestion(rightChoice.id)
                        }}
                        style={{ transform: `translateX(${bossSwipeOffset}px) rotate(${bossSwipeOffset / 18}deg)` }}
                      >
                        <span className="boss-swipe-glyph" aria-hidden="true">↔</span>
                        <strong>{bossHasAnswered ? 'ล็อกคำตอบแล้ว' : 'ปัดเพื่อตัดสิน'}</strong>
                        <small>ซ้าย ← หรือ → ขวา</small>
                      </div>
                      <div className="boss-swipe-actions">
                        {leftChoice ? <button type="button" onClick={() => void answerBossQuestion(leftChoice.id)} disabled={areAnswersLocked(saving, bossTimeExpired) || bossHasAnswered}>← {leftChoice.text}</button> : null}
                        {rightChoice ? <button type="button" onClick={() => void answerBossQuestion(rightChoice.id)} disabled={areAnswersLocked(saving, bossTimeExpired) || bossHasAnswered}>{rightChoice.text} →</button> : null}
                      </div>
                    </div>
                  )
                })() : (
                  <div className={`boss-rapid-choices boss-rapid-choices-${bossQuestion.bossInteraction?.kind ?? 'legacy'}`}>
                    {bossOrderedChoices.map((choice, index) => (
                      <button
                        key={choice.id}
                        className={`boss-rapid-choice ${bossSelectedChoiceId === choice.id ? 'boss-rapid-choice-selected' : ''}`}
                        type="button"
                        onClick={() => void answerBossQuestion(choice.id)}
                        disabled={areAnswersLocked(saving, bossTimeExpired) || bossHasAnswered}
                      >
                        <span className="boss-rapid-choice-icon" aria-hidden="true">{bossQuestion.bossInteraction?.choiceIcons?.[choice.id] ?? ['ก', 'ข', 'ค', 'ง'][index]}</span>
                        <strong>{choice.text}</strong>
                      </button>
                    ))}
                  </div>
                )}

                <div className="feedback-region mt-5" aria-live="assertive">
                  {error ? <p className="error-message">{error}</p> : bossTimeExpired ? bossSelectedChoiceId ? (
                    <div className="boss-rapid-locked">
                      <strong>✦ ผนึกคำตอบแล้ว</strong>
                      <span>เวลาที่ใช้ {((bossSavedAnswer?.responseTimeMs ?? 0) / 1_000).toFixed(2)} วินาที</span>
                      <small>{bossRevealRemainingMs > 0 ? 'เตรียมจังหวะถัดไป…' : 'กำลังไปจังหวะถัดไป'}</small>
                    </div>
                  ) : (
                    <div className="answer-result-missed"><strong>หมดเวลา — ข้อนี้นับเป็นไม่ตอบ</strong></div>
                  ) : saving ? (
                    <p>กำลังผนึกคำตอบ...</p>
                  ) : bossHasAnswered ? (
                    <p className="answer-waiting"><span aria-hidden="true">✓</span> ล็อกแล้ว — รอจังหวะถัดไป</p>
                  ) : null}
                </div>
              </section>

              <p className="mx-auto mt-4 max-w-2xl text-center text-xs leading-relaxed text-[#999187]">3 จังหวะสั้น ๆ • ไม่เฉลยระหว่างทาง • วัดความแม่นก่อน แล้วจึงวัดเวลารวมเพื่อชิงมนตรา</p>
            </>
          )
        ) : !question ? (
          <ErrorPanel message="ไม่พบคำถามของรอบนี้ กรุณาแจ้งครูผู้ควบคุมกิจกรรม" />
        ) : (
          <>
            <header className="game-header">
              <div className="min-w-0">
                <p className="text-xs text-[#aaa298]">ผู้เล่น</p>
                <strong className="block truncate text-[#fff7df]">
                  {player.displayName}
                  {isCaptain ? <span className="ml-2 text-xs font-semibold text-[#f2d58d]" title="หัวหน้าทีม">👑 หัวหน้าทีม</span> : null}
                </strong>
                <small className="block truncate text-[#c0b7ab]">{assignedTeamDisplayName}</small>
                <TeamItemStatus inventory={magicState.data?.inventory} className="mt-1" />
              </div>
              <div className="text-right"><p className="text-xs text-[#aaa298]">รอบที่ {room.currentRound}</p><strong className={`question-timer ${remainingMs <= 5_000 ? 'question-timer-urgent' : ''}`}>{timeExpired ? 'หมดเวลา' : formatCountdown(remainingMs)}</strong></div>
            </header>

            {/* Two columns on a landscape tablet: question + answers on the left, the team item
                panel on the right, so a captain never has to scroll to reach activation. Below
                the breakpoint this collapses back to the original single column. */}
            <div className="game-columns">
              <div className="game-columns-main">

            <section className="mt-4" aria-label={`คำถามข้อ ${questionIndex + 1} จาก 10 ข้อ`}>
              <div className="mb-2 flex justify-between text-sm"><span>คำถามที่ {Math.min(questionIndex + 1, 10)} จาก 10</span><span className="text-[#c9a55f]">ทุกคนใช้เวลาเท่ากัน</span></div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            </section>

            <section className={`question-card mt-5 ${hasAnswered ? 'answer-saved' : ''} ${activeEffectKind ? `question-card-effect question-card-effect-${activeEffectKind}` : ''}`}>
              {/* Active-effect frame: an animated border sweep plus a corner badge, so a student
                  can tell at a glance that this particular question is affected. Purely visual —
                  scoring, timing and the answer flow are untouched. */}
              {activeEffectKind ? (
                <>
                  <span className="question-card-effect-frame" aria-hidden="true" />
                  {/* Seal is announced by the in-flow banner below instead of this overhanging
                      corner badge, which sat outside the card edge and clipped. */}
                  {activeEffectKind === 'seal' ? null : (
                    <span className={`question-card-effect-badge question-card-effect-badge-${activeEffectKind}`}>
                      {activeEffectKind === 'surge'
                        ? <><b>×2</b><small>คะแนนแข่งขัน</small></>
                        : <><b>🔮</b><small>มายา</small></>}
                    </span>
                  )}
                </>
              ) : null}
              {/* Score Seal banner. A normal in-flow block as the first thing in the card, so it
                  aligns with the card's inner edges by construction — no absolute positioning, no
                  negative margin, no transform. States the effect once, with one supporting line;
                  every figure comes from computeHostileMultiplier, the math is untouched. */}
              {activeEffectKind === 'seal' ? (() => {
                const sealCopy = buildScoreSealCopy(incomingSealCount)
                return (
                  <p className="score-seal-banner" role="status">
                    <strong>{sealCopy.primary}</strong>
                    <span>{sealCopy.detail}</span>
                  </p>
                )
              })() : null}
              <div className="flex items-center justify-between gap-3"><span className="category-chip">{categoryLabel}</span><span className="text-sm text-[#aaa298]">เปลี่ยนคำตอบได้จนหมดเวลา</span></div>
              <h1 className="mt-5 text-xl font-semibold leading-relaxed sm:text-2xl">{question.question}</h1>
              {illusionHiddenChoiceIds.length > 0 ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-[#c9a5f0]"><MagicItemIcon itemType="illusion" size="sm" /> ✨ ตัดคำตอบผิดออกแล้ว 2 ตัว</p>
              ) : null}
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {visibleChoices.map((choice, index) => (
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
                    <strong>{answerWasCorrect ? '✓ ตอบถูก +10 คะแนน' : '✕ ตอบผิด'}</strong>
                    <span>คะแนนความรู้สะสมของคุณ {knowledgeScore100}/100</span>
                    <small>{revealRemainingMs > 0 ? `ไปข้อถัดไปใน ${Math.ceil(revealRemainingMs / 1_000)} วินาที` : 'กำลังไปคำถามข้อถัดไป'}</small>
                  </div>
                ) : (
                  <div className="answer-result-missed"><strong>ไม่ได้ตอบภายในเวลา</strong><span>คะแนนความรู้สะสมของคุณ {knowledgeScore100}/100</span></div>
                ) : saving ? (
                  <p>กำลังบันทึกคำตอบ...</p>
                ) : hasAnswered ? (
                  <p className="answer-waiting"><span aria-hidden="true">✓</span> บันทึกแล้ว แตะตัวเลือกอื่นเพื่อเปลี่ยนได้จนหมดเวลา</p>
                ) : null}
              </div>
            </section>

            {showBreakdown && breakdown ? (
              <section className="glass-panel mt-4 p-4 text-sm" aria-live="polite">
                <p className="eyebrow">สรุปคะแนนทีมข้อนี้</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div><dt className="text-xs text-[#aaa298]">คะแนนดิบทีม</dt><dd className="mt-1 text-lg font-semibold text-[#fff7df]">{breakdown.rawScore.toFixed(1)}</dd></div>
                  <div><dt className="text-xs text-[#aaa298]">มนตรา</dt><dd className="mt-1 text-lg font-semibold text-[#f2d58d]">{formatMultiplier(breakdown.ownMultiplier)} / {formatMultiplier(breakdown.hostileMultiplier)}</dd></div>
                  <div><dt className="text-xs text-[#aaa298]">คะแนนแข่งขัน</dt><dd className="mt-1 text-lg font-semibold text-[#9ee6b4]">{breakdown.competitionScore.toFixed(1)}</dd></div>
                </dl>
              </section>
            ) : null}

            {rosterState.data ? (
              <section className="mt-4 text-center text-sm text-[#c9a55f]" aria-live="polite">
                {teamRosterSize > 0 && teamAnsweredCount >= teamRosterSize
                  ? 'ตอบครบทั้งทีมแล้ว'
                  : `ทีมของคุณตอบแล้ว ${teamAnsweredCount}/${teamRosterSize} คน`}
              </section>
            ) : null}

              </div>

              <aside className="game-columns-side">

            {player.teamId ? (
              <MagicPanel
                magic={magicState.data}
                magicLoading={magicState.loading}
                teams={displayTeams}
                isHolder={magicState.data?.magicHolderPlayerId === player.id}
                roomStatus={room.status}
                roomCode={normalizedCode}
                currentRound={room.currentRound}
                currentQuestionIndex={room.currentQuestionIndex}
                events={magicEventsState.data}
                canActivateNow={canActivateMagicNow}
                affectedQuestionIndex={activationWindow.valid ? activationWindow.affectedQuestionIndex : null}
                onChoose={(itemType) => service.chooseStartingItem(normalizedCode, player.teamId as string, player.id, itemType)}
                onActivate={(itemType, targetTeamId) => service.activateItem(normalizedCode, player.teamId as string, player.id, itemType, targetTeamId)}
              />
            ) : null}
              </aside>
            </div>
          </>
        )}
      </div>
    </ScenePage>
  )
}
