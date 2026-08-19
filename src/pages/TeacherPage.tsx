import { useEffect, useMemo, useRef, useState } from 'react'
import { BackgroundMusicControls } from '../components/BackgroundMusicControls'
import { BossBoard } from '../components/BossBoard'
import { BossResultDetails } from '../components/BossResultDetails'
import { EvidenceSummaryPanel } from '../components/EvidenceSummaryPanel'
import { TeacherReportPrintView } from '../components/TeacherReportPrintView'
import { GrimoireModal } from '../components/GrimoireModal'
import { Link } from 'react-router-dom'
import { ConfirmDialog, ErrorPanel, LoadingPanel, ScenePage, StatusPill } from '../components/Layout'
import { MagicItemIcon } from '../components/MagicItemIcon'
import { NumberStepper, SettingStepper } from '../components/NumberStepper'
import { TeacherAssessmentStage } from '../components/TeacherAssessmentStage'
import { TeacherResultCommandCenter } from '../components/TeacherResultCommandCenter'
import { TeamItemStatus } from '../components/TeamItemStatus'
import { useGame } from '../context/GameContext'
import { useBackgroundMusic } from '../hooks/useBackgroundMusic'
import { useAllCaptainVoteProgress, useAllTeamGuardianNames, useAllTeamMagic, useMagicEvents, useRoom, usePlayers, useRoundHistory } from '../hooks/useGameData'
import { ANSWER_REVEAL_MILLISECONDS, RECALL_REVEAL_MILLISECONDS, bossQuestionTiming, isAssessmentExpired, postTestProgressOf, postTestWindow, preTestProgressOf, preTestWindow, getQuestionDeadline, getRemainingMilliseconds, getRevealRemainingMilliseconds, getTeacherVisiblePlayer, isCurrentQuestionRevealed, mainQuestionTiming, recallQuestionTiming } from '../lib/gameFlow'
import { BOSS_REVEAL_MILLISECONDS } from '../lib/boss'
import { resolveTeacherRoomSession } from '../lib/game'
import { ASSESSMENT_QUESTION_COUNT } from '../data/assessmentQuestions'
import { SURVEY_ITEM_COUNT } from '../data/surveyItems'
import { computeEvidenceSummary, computeEvidenceSummaryFromHistory } from '../lib/evidenceSummary'
import { computeClassRecallSummary } from '../lib/learning'
import { downloadLearningWorkbook } from '../lib/learningExport'
import { buildRoundHistoryEntry } from '../lib/roundHistory'
import { buildTeacherSpellEventCopy, computeHostileMultiplier, computeTeamCompetitionStats, formatHostilePercent, getMagicEffectPhase, hasAnyMagicItem, MAGIC_ITEM_INFO, MAGIC_ITEM_TYPES, type MagicEventCopy } from '../lib/magic'
import { computeCurrentQuestionStats, computeTeamCurrentQuestionCounts, computeTeamStats, TEAM_GUARDIAN_NAME_MAX_LENGTH, TEAM_GUARDIAN_NAME_MIN_LENGTH } from '../lib/teamScoring'
import { friendlyError } from '../services'
import { getTeacherSession, hasShownMagicPopup, markMagicPopupShown, saveTeacherSession } from '../services/sessionStorage'
import { recallQuestionsById } from '../data/recallQuestions'
import {
  createEmptyMagicInventory,
  DEFAULT_BOSS_QUESTION_DURATION_SECONDS,
  MAX_BOSS_SECONDS_PER_QUESTION,
  MAX_RECALL_SECONDS_PER_ITEM,
  MIN_BOSS_SECONDS_PER_QUESTION,
  MAX_ASSESSMENT_SECONDS_PER_QUESTION,
  MIN_ASSESSMENT_SECONDS_PER_QUESTION,
  DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION,
  MIN_RECALL_SECONDS_PER_ITEM,
  RECALL_QUESTION_COUNT,
  RECALL_SECONDS_PER_ITEM,
  type Player,
} from '../types/game'

type ConfirmAction = 'prepare' | 'start' | 'stop' | 'close' | 'startRecall' | null

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

// Number of team colour slots defined in styles.css (.team-tone-0 … .team-tone-11). Teams beyond
// this count wrap around and reuse a colour — a class of 12 teams is already well past what the
// room is designed for, and reusing beats running out.
const TEAM_TONE_COUNT = 12

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
          <th className="pb-3 pr-3 text-center">คะแนนความรู้</th>
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
              <td className="py-2 pr-3 text-center font-semibold text-[#f2d58d]">{player.score * 10}/100</td>
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
  // Teacher-configurable timers, both in plain seconds and both defaulted to the values the game
  // used before they were configurable.
  const [recallDurationValue, setRecallDurationValue] = useState(String(RECALL_SECONDS_PER_ITEM))
  const [assessmentDurationValue, setAssessmentDurationValue] = useState(String(DEFAULT_ASSESSMENT_SECONDS_PER_QUESTION))
  const [bossDurationValue, setBossDurationValue] = useState(String(DEFAULT_BOSS_QUESTION_DURATION_SECONDS))
  const [teamCountValue, setTeamCountValue] = useState('2')
  const [resultsTab, setResultsTab] = useState<'team' | 'individual'>('team')
  const [now, setNow] = useState(Date.now())
  const advancingQuestion = useRef({ key: '', attemptedAt: 0 })
  const advancingBossQuestion = useRef({ key: '', attemptedAt: 0 })
  const closingQuestion = useRef({ key: '', attemptedAt: 0 })

  const sortedPlayers = useMemo(() => [...playersState.data].sort((a, b) => a.joinedAt - b.joinedAt), [playersState.data])
  const parsedDuration = Number(durationValue)
  const questionDurationSeconds = Math.round(parsedDuration * (durationUnit === 'minutes' ? 60 : 1))
  const durationValid = Number.isFinite(questionDurationSeconds) && questionDurationSeconds >= 5 && questionDurationSeconds <= 600
  // Seconds PER QUESTION, same unit and same step size as the Recall control beside it.
  const assessmentSecondsPerQuestion = Math.round(Number(assessmentDurationValue))
  const assessmentDurationValid = Number.isFinite(assessmentSecondsPerQuestion)
    && assessmentSecondsPerQuestion >= MIN_ASSESSMENT_SECONDS_PER_QUESTION && assessmentSecondsPerQuestion <= MAX_ASSESSMENT_SECONDS_PER_QUESTION
  const recallDurationSeconds = Math.round(Number(recallDurationValue))
  const recallDurationValid = Number.isFinite(recallDurationSeconds)
    && recallDurationSeconds >= MIN_RECALL_SECONDS_PER_ITEM && recallDurationSeconds <= MAX_RECALL_SECONDS_PER_ITEM
  const bossDurationSeconds = Math.round(Number(bossDurationValue))
  const bossDurationValid = Number.isFinite(bossDurationSeconds)
    && bossDurationSeconds >= MIN_BOSS_SECONDS_PER_QUESTION && bossDurationSeconds <= MAX_BOSS_SECONDS_PER_QUESTION
  const parsedTeamCount = Math.round(Number(teamCountValue))
  const teamCountValid = Number.isFinite(parsedTeamCount) && parsedTeamCount >= 1 && parsedTeamCount <= 20
  const mainTiming = roomState.data ? mainQuestionTiming(roomState.data) : null
  const remainingMs = mainTiming ? getRemainingMilliseconds(mainTiming, now) : 0
  const revealRemainingMs = mainTiming ? getRevealRemainingMilliseconds(mainTiming, now) : 0
  const currentQuestionId = roomState.data?.questionIds[roomState.data.currentQuestionIndex]

  // Milestone 4: boss-phase timing mirrors the main flow's, fed a boss-shaped
  // {questionStartedAt: bossQuestionStartedAt, questionDurationSeconds: bossQuestionDurationSeconds,
  // questionClosedAt: null} object (boss has no early-close).
  const isBossPhase = roomState.data?.phase === 'boss'
  // Learning Layer: mandatory individual "ทบทวนเรื่องราว" phase every round begins in —
  // completion is purely a count derived from the already-subscribed players list (each
  // player's own recallAnswers, teacher-readable the same way every other player field is).
  // Stage comes off room.phase ('lobby' and 'recall' are distinct values, so no cross-check is
  // needed to tell "waiting for students" apart from "Recall running"). The status === 'waiting'
  // requirement serves a DIFFERENT purpose: 'closed' and 'completed' are terminal statuses that
  // must outrank any pre-game stage. closeRoom only changes status — it leaves phase as-is — so
  // without this, closing a room mid-Recall left the teacher stuck on a dead room's stage screen
  // with the dashboard (and its "สร้างห้องใหม่" escape) still hidden behind it. This mirrors the
  // precedence resolveStudentRoute already applies for students (closed/winner/completed are all
  // checked before phase === 'recall').
  const isPreGameStage = roomState.data?.status === 'waiting'
  // The room-control header + room bar exist to run the pre-game stages (lobby, recall,
  // teamSetup). They are hidden for main/boss and for the result/podium/learning-summary views,
  // which is exactly the same set of stages status === 'waiting' already identifies.
  const showRoomControls = isPreGameStage
  const isLobbyPhase = isPreGameStage && roomState.data?.phase === 'lobby'
  const isPreTestPhase = isPreGameStage && roomState.data?.phase === 'preTest'
  // Post-test runs while the room is still 'playing', so it is deliberately NOT part of
  // isPreGameStage (which means status === 'waiting').
  const isPostTestPhase = roomState.data?.status === 'playing' && roomState.data?.phase === 'postTest'
  const postTestCompletedCount = playersState.data.filter((player) => player.postTestProgress >= ASSESSMENT_QUESTION_COUNT).length
  const isSurveyPhase = roomState.data?.status === 'playing' && roomState.data?.phase === 'survey'
  const surveyCompletedCount = playersState.data.filter((player) => player.surveyResponses.length >= SURVEY_ITEM_COUNT).length
  // Completion = answered every item in the bank. Derived from counts only — no answer data.
  const preTestCompletedCount = playersState.data.filter((player) => player.preTestProgress >= ASSESSMENT_QUESTION_COUNT).length
  // Anyone short of a full bank — whether they never started or stopped halfway. This is exactly
  // the group the pre/post comparison will exclude, which is what the confirmation warns about.
  const preTestIncompleteCount = playersState.data.length - preTestCompletedCount
  const isRecallPhase = isPreGameStage && roomState.data?.phase === 'recall'
  const isTeamSetupPhase = isPreGameStage && roomState.data?.phase === 'teamSetup'
  const recallCompletedCount = playersState.data.filter((player) => player.recallAnswers.length >= RECALL_QUESTION_COUNT).length
  // Recall progress is the ROOM's shared timeline, not any student's own answer count.
  const recallQuestionIndex = roomState.data?.recallQuestionIndex ?? 0
  const recallSequenceFinished = recallQuestionIndex >= RECALL_QUESTION_COUNT
  const bossTiming = roomState.data ? bossQuestionTiming(roomState.data) : null
  const bossRemainingMs = bossTiming ? getRemainingMilliseconds(bossTiming, now) : 0
  const bossDeadline = bossTiming ? getQuestionDeadline(bossTiming) : null
  const bossRevealRemainingMs = bossDeadline != null && now >= bossDeadline
    ? Math.max(0, bossDeadline + BOSS_REVEAL_MILLISECONDS - now)
    : 0

  // While a question is live, hide each player's just-answered (unrevealed) score bump from
  // the teacher view the same way the previous per-login-team scoreboard did — this now
  // feeds team aggregation too, so a team's live average can't be gamed by watching reveals.
  const visiblePlayers = useMemo(() => {
    const room = roomState.data
    if (!room || room.status !== 'playing') return playersState.data
    // Withholds the current question's ANSWER RECORD, not just its score point. Team correct
    // counts and competition scores are both derived from `answers`, so trimming only the score
    // (as this used to) still let "ถูก N ข้อ" and the competition average tick upward the moment
    // someone guessed right — turning the projected screen into an answer oracle.
    return playersState.data.map((player) => getTeacherVisiblePlayer(room, player, now))
  }, [now, playersState.data, roomState.data])

  // Whether the current question's correctness may be shown at all. Everything gated on this is
  // hidden while the answer window is live and appears the moment the reveal begins.
  const currentQuestionRevealed = roomState.data ? isCurrentQuestionRevealed(roomState.data, now) : true
  // Join order, but reveal-safe — used anywhere a per-student view could otherwise expose the
  // current question's ✓/✕ (the printable report in particular).
  const visibleSortedPlayers = useMemo(() => [...visiblePlayers].sort((a, b) => a.joinedAt - b.joinedAt), [visiblePlayers])

  const magicState = useAllTeamMagic(roomCode)
  const magicEventsState = useMagicEvents(roomCode)
  const captainVoteProgressState = useAllCaptainVoteProgress(roomCode)
  const guardianNamesState = useAllTeamGuardianNames(roomCode)
  // Immutable per-round learning snapshots. Survives round resets and room close, unlike the
  // live player docs the current-round summary reads.
  const roundHistoryState = useRoundHistory(roomCode)
  // Teacher-only background music. Lives at the page level so the single audio element spans
  // every stage — Recall, Team Setup, Main, Boss, Result and the Learning Summary all render
  // inside this same mounted component, so nothing here restarts between them.
  const backgroundMusic = useBackgroundMusic()
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRounds = useMemo(() => [...new Set(roundHistoryState.data.map((entry) => entry.round))], [roundHistoryState.data])

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
  // Story Recall reporting only, from raw playersState.data (never visiblePlayers/magic-adjusted/
  // team-scored). This is the review activity's own accuracy — it is never paired with the main
  // game's knowledge score to produce a before/after or gain figure.
  const classRecallSummary = useMemo(() => computeClassRecallSummary(playersState.data), [playersState.data])
  const currentQuestionStats = useMemo(
    () => computeCurrentQuestionStats(playersState.data, currentQuestionId),
    [playersState.data, currentQuestionId],
  )
  const currentQuestionCounts = useMemo(
    () => computeTeamCurrentQuestionCounts(playersState.data, roomState.data?.teams ?? [], currentQuestionId),
    [playersState.data, roomState.data?.teams, currentQuestionId],
  )
  const teamNameById = useMemo(() => new Map((roomState.data?.teams ?? []).map((team) => [team.id, team.name])), [roomState.data?.teams])
  // Stable colour slot per team, taken from the team's position in room.teams. Position is what
  // "ทีม N" already numbers from, so the colour always matches the name a teacher reads out. The
  // palette cycles, so any number of teams gets a colour.
  const teamToneById = useMemo(
    () => new Map((roomState.data?.teams ?? []).map((team, index) => [team.id, index % TEAM_TONE_COUNT])),
    [roomState.data?.teams],
  )
  // Item 6: guardian name (once a captain sets one) replaces the generic "ทีม N" label
  // everywhere on this screen — teamNameById above stays the "ทีม N" fallback source, never
  // itself replaced, so guardianDisplayName always has something to fall back to.
  const guardianNameById = useMemo(() => new Map(guardianNamesState.data.map((entry) => [entry.teamId, entry.name])), [guardianNamesState.data])
  // Merged lookup ("ทีม N" fallback under a guardian name once set) so every existing
  // `teamNameById.get(...)` call site (including the standalone IndividualResultsTable
  // component below, which receives this as a prop) picks up guardian names automatically.
  const displayTeamNameById = useMemo(() => {
    const map = new Map<string, string>()
    teamNameById.forEach((fallbackName, teamId) => map.set(teamId, guardianNameById.get(teamId) ?? fallbackName))
    return map
  }, [teamNameById, guardianNameById])
  const guardianDisplayName = (teamId: string): string => displayTeamNameById.get(teamId) ?? teamId

  // The just-finished round has no stored snapshot yet — those are only written when the teacher
  // prepares a new round, stops, or closes the room. Rather than persisting early (which would
  // risk a duplicate snapshot later), the current round's entries are derived in memory from the
  // live players using the very same pure builder the service uses, then merged under stored
  // history with stored entries winning. So the export is available the instant the round ends,
  // and nothing is written.
  const exportEntries = useMemo(() => {
    const room = roomState.data
    if (!room) return roundHistoryState.data
    const storedIds = new Set(roundHistoryState.data.map((entry) => entry.id))
    const completedAt = room.completedAt ?? Date.now()
    // A round that has not finished yet has nothing to snapshot: after prepareNextRound the live
    // players are all zeroed, and deriving from them would add a phantom round of empty rows to
    // the history list, the export and the round picker.
    const roundEnded = room.status === 'completed' || room.status === 'closed'
    const currentRoundEntries = (roundEnded ? playersState.data : [])
      .map((player) => {
        const teamName = player.teamId
          ? displayTeamNameById.get(player.teamId) ?? ''
          : ''
        return buildRoundHistoryEntry(player, room.currentRound, teamName, completedAt)
      })
      .filter((entry) => !storedIds.has(entry.id))
    return [...roundHistoryState.data, ...currentRoundEntries]
      .sort((a, b) => a.round - b.round || a.studentNumber.localeCompare(b.studentNumber))
  }, [roomState.data, roundHistoryState.data, playersState.data, displayTeamNameById])
  // Every round the teacher can inspect: stored history plus the just-finished round.
  const availableRounds = useMemo(
    () => [...new Set(exportEntries.map((entry) => entry.round))].sort((a, b) => b - a),
    [exportEntries],
  )
  // Defaults to the newest available round, and follows it as new rounds land — but a teacher who
  // picks an older round keeps that choice.
  const [selectedRound, setSelectedRound] = useState<number | null>(null)
  const activeRound = selectedRound !== null && availableRounds.includes(selectedRound)
    ? selectedRound
    : availableRounds[0] ?? null
  // Source selection: the CURRENT round may read live players (they are still intact right after
  // completion); any other round must come from the durable history snapshot. This is what keeps
  // a past round readable after prepareNextRound wipes the live arrays.
  const selectedEvidence = useMemo(() => {
    if (activeRound === null) return null
    const isCurrentRound = activeRound === roomState.data?.currentRound
    const historyForRound = exportEntries.filter((entry) => entry.round === activeRound)
    if (isCurrentRound && playersState.data.length > 0 && historyForRound.length === 0) {
      return computeEvidenceSummary(playersState.data)
    }
    return computeEvidenceSummaryFromHistory(historyForRound)
  }, [activeRound, exportEntries, playersState.data, roomState.data?.currentRound])
  // The printed report follows whichever round the teacher SELECTED — printing a past round must
  // print that round, never quietly fall back to the current one.
  const printEvidence = selectedEvidence ?? computeEvidenceSummaryFromHistory([])
  const printRound = activeRound ?? roomState.data?.currentRound ?? 0
  const magicByTeamId = useMemo(() => new Map(magicState.data.map((magic) => [magic.teamId, magic])), [magicState.data])
  const playerNameById = useMemo(() => new Map(playersState.data.map((player) => [player.id, player.displayName])), [playersState.data])
  // Milestone 4.1: only counts progress entries matching the team's CURRENT election attempt —
  // a stale entry from before a reopen/reset is simply never counted again (see
  // captainElectionAttempt's doc comment in types/game.ts).
  const votedCountByTeam = useMemo(() => {
    const counts = new Map<string, number>()
    captainVoteProgressState.data.forEach((entry) => {
      const magic = magicByTeamId.get(entry.teamId)
      if (!magic || entry.electionAttempt !== magic.captainElectionAttempt) return
      counts.set(entry.teamId, (counts.get(entry.teamId) ?? 0) + 1)
    })
    return counts
  }, [captainVoteProgressState.data, magicByTeamId])

  // Item 1 (follow-up): incoming (still-queued, unresolved) score_seal count per team this
  // round — was previously only computed inline inside the (now-removed) per-team card map;
  // memoized here since the scoreboard row now needs it too, alongside the lower history log.
  // questionIndex tracks the soonest affected question per team — used to tell whether the
  // badge should read "queued" (ข้อต่อไป) or "active" (กำลังมีผลในข้อนี้), same distinction
  // MagicPanel's incomingSealSummaries already makes on the student side.
  const incomingSealCountByTeam = useMemo(() => {
    const counts = new Map<string, { count: number; questionIndex: number }>()
    magicEventsState.data.forEach((event) => {
      if (event.round !== roomState.data?.currentRound || event.status !== 'queued' || event.itemType !== 'score_seal' || !event.targetTeamId || event.affectedQuestionIndex == null) return
      const existing = counts.get(event.targetTeamId)
      counts.set(event.targetTeamId, {
        count: (existing?.count ?? 0) + 1,
        questionIndex: existing ? Math.min(existing.questionIndex, event.affectedQuestionIndex) : event.affectedQuestionIndex,
      })
    })
    return counts
  }, [magicEventsState.data, roomState.data?.currentRound])

  const highestAverage = competitionStats[0]?.competitionAverage ?? 0
  const overallAverage = competitionStats.length > 0 ? competitionStats.reduce((total, team) => total + team.competitionAverage, 0) / competitionStats.length : 0
  const leadingTeams = competitionStats.filter((team) => team.memberCount > 0 && team.competitionAverage === highestAverage)
  const leadingTeamLabel = leadingTeams.length > 1 ? `${leadingTeams.length} ทีมคะแนนเท่ากัน` : (leadingTeams[0] ? guardianDisplayName(leadingTeams[0].id) : '-')
  const unassignedCount = sortedPlayers.filter((player) => player.teamId == null).length
  // Milestone 4.1: mirrors startRoom's own server-side gate, purely for a clearer disabled
  // button + helper message — the service call remains the actual enforcement.
  const teamsWithoutCaptain = (roomState.data?.teams ?? []).filter((team) => magicByTeamId.get(team.id)?.magicHolderPlayerId == null)
  // Item 6: same "clearer disabled button" purpose as teamsWithoutCaptain above — the actual
  // enforcement is startRoom's own precondition check (firebaseService.ts/demoService.ts).
  const teamsWithoutName = (roomState.data?.teams ?? []).filter((team) => !(guardianNameById.get(team.id) ?? '').trim())
  // This precondition already existed server-side (startRoom throws if any team never chose a
  // starting item) but was never mirrored into the button's disabled condition until now —
  // completing it here alongside the name check, per the requirement that all three
  // (captain + name + item) gate game start together.
  const teamsWithoutStartingItem = (roomState.data?.teams ?? []).filter((team) => !hasAnyMagicItem(magicByTeamId.get(team.id)?.inventory ?? createEmptyMagicInventory()))

  // Milestone 2.2: teacher early-reveal / manual-advance controls. "All answered" only
  // considers currently-registered players (sortedPlayers), matching currentQuestionStats.
  const allAnsweredCurrentQuestion = sortedPlayers.length > 0 && currentQuestionStats.answeredCount === sortedPlayers.length
  const canCloseQuestionEarly = Boolean(
    roomState.data?.status === 'playing' && remainingMs > 0 && roomState.data.questionClosedAt == null && allAnsweredCurrentQuestion,
  )
  const canAdvanceNow = Boolean(roomState.data?.status === 'playing' && revealRemainingMs > 0)

  useEffect(() => {
    const room = roomState.data
    // Milestone 4: phase !== 'main' skips this effect during the boss phase — questionStartedAt
    // is left stale (still question 5's) once boss starts, since advanceQuestion's boss-trigger
    // branch has no reason to touch it; the separate boss auto-advance effect below owns timing
    // while phase === 'boss'.
    if (!room || room.status !== 'playing' || room.phase !== 'main') return
    const questionKey = `${room.currentRound}-${room.currentQuestionIndex}`
    if (advancingQuestion.current.key && advancingQuestion.current.key !== questionKey) advancingQuestion.current = { key: '', attemptedAt: 0 }
    const tick = (): void => {
      const currentTime = Date.now()
      setNow(currentTime)
      const deadline = getQuestionDeadline(mainQuestionTiming(room))
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

  // Recall auto-advance: the same teacher-client-driven, debounced "answer window, then reveal,
  // then advance" loop the main flow uses, fed a recall-shaped timing object. This is what makes
  // Recall room-synchronized — students never advance themselves. advanceRecallQuestion's own
  // expectedRecallIndex guard makes a duplicate tick a no-op, so a question can never be skipped.
  const advancingRecallQuestion = useRef({ key: '', attemptedAt: 0 })
  useEffect(() => {
    const room = roomState.data
    if (!room || room.status !== 'waiting' || room.phase !== 'recall') return
    if (room.recallQuestionIndex >= RECALL_QUESTION_COUNT) return
    const recallKey = `${room.currentRound}-recall-${room.recallQuestionIndex}`
    if (advancingRecallQuestion.current.key && advancingRecallQuestion.current.key !== recallKey) {
      advancingRecallQuestion.current = { key: '', attemptedAt: 0 }
    }
    const tick = (): void => {
      const currentTime = Date.now()
      setNow(currentTime)
      const deadline = getQuestionDeadline(recallQuestionTiming(room))
      const recentlyAttempted = advancingRecallQuestion.current.key === recallKey && currentTime - advancingRecallQuestion.current.attemptedAt < 3_000
      // Recall uses its OWN, much shorter reveal window (~1s) rather than Main's 4s: five short
      // review items back to back made the longer hold read as dead air. Main is untouched — it
      // still needs the longer pause for the competitive score breakdown.
      if (deadline == null || currentTime < deadline + RECALL_REVEAL_MILLISECONDS || recentlyAttempted) return
      advancingRecallQuestion.current = { key: recallKey, attemptedAt: currentTime }
      void service.advanceRecallQuestion(roomCode, teacherSessionId, room.recallQuestionIndex).catch((reason) => {
        advancingRecallQuestion.current = { key: '', attemptedAt: 0 }
        setError(friendlyError(reason))
      })
    }
    tick()
    const intervalId = window.setInterval(tick, 250)
    return () => window.clearInterval(intervalId)
  }, [roomCode, roomState.data, service, teacherSessionId])

  // Milestone 4: boss-phase counterpart of the auto-advance effect above — same debounced
  // deadline-driven "reveal, then advance" shape, reusing getQuestionDeadline/ANSWER_REVEAL_MILLISECONDS
  // fed a boss-shaped {questionStartedAt: bossQuestionStartedAt, questionDurationSeconds:
  // bossQuestionDurationSeconds, questionClosedAt: null} object (boss has no early-close).
  useEffect(() => {
    const room = roomState.data
    // Item 5: bossAwaitingContinue is the pause gate — once the 3rd boss question resolves and
    // sets it, this polling effect must stop ticking (belt-and-suspenders with the service-side
    // guard in advanceBossQuestion) so nothing re-fires while the room waits for the teacher's
    // explicit "เล่นต่อ" (continueAfterBoss is the only method that ever clears it).
    if (!room || room.status !== 'playing' || room.phase !== 'boss' || room.bossAwaitingContinue) return
    const bossKey = `${room.currentRound}-boss-${room.bossQuestionIndex}`
    if (advancingBossQuestion.current.key && advancingBossQuestion.current.key !== bossKey) advancingBossQuestion.current = { key: '', attemptedAt: 0 }
    const tick = (): void => {
      const currentTime = Date.now()
      setNow(currentTime)
      const deadline = getQuestionDeadline(bossQuestionTiming(room))
      const recentlyAttempted = advancingBossQuestion.current.key === bossKey && currentTime - advancingBossQuestion.current.attemptedAt < 3_000
      if (deadline == null || currentTime < deadline + BOSS_REVEAL_MILLISECONDS || recentlyAttempted) return
      advancingBossQuestion.current = { key: bossKey, attemptedAt: currentTime }
      void service.advanceBossQuestion(roomCode, teacherSessionId, room.bossQuestionIndex).catch((reason) => {
        advancingBossQuestion.current = { key: '', attemptedAt: 0 }
        setError(friendlyError(reason))
      })
    }
    tick()
    const intervalId = window.setInterval(tick, 250)
    return () => window.clearInterval(intervalId)
  }, [roomCode, roomState.data, service, teacherSessionId])

  // Milestone 4.1: "when all members of a team have voted, finalize that team automatically" —
  // driven by the TEACHER's client polling vote progress (mirroring how main-question/boss
  // auto-advance are already teacher-client-driven), not by the last voter's own write — see
  // firestore.rules' doc comment on magic/{teamId} for why a student-triggered finalize could
  // never be safely validated there. finalizingCaptain guards against firing a second
  // finalizeCaptainElection call for the same team while an earlier one is still in flight.
  const finalizingCaptain = useRef<Record<string, boolean>>({})
  useEffect(() => {
    const room = roomState.data
    if (!room || room.status !== 'waiting' || !room.teamsLocked) return
    room.teams.forEach((team) => {
      const magic = magicByTeamId.get(team.id)
      if (!magic || magic.magicHolderPlayerId != null) return
      const memberCount = teamStatsById.get(team.id)?.memberCount ?? 0
      const votedCount = votedCountByTeam.get(team.id) ?? 0
      if (memberCount === 0 || votedCount < memberCount) return
      if (finalizingCaptain.current[team.id]) return
      finalizingCaptain.current[team.id] = true
      void service.finalizeCaptainElection(roomCode, teacherSessionId, team.id)
        .catch((reason) => setError(friendlyError(reason)))
        .finally(() => { finalizingCaptain.current[team.id] = false })
    })
  }, [roomState.data, magicByTeamId, teamStatsById, votedCountByTeam, roomCode, service, teacherSessionId])

  // Milestone 4.1: manual "finalize early" (for teams with missing voters) and "reopen/reset the
  // election" — both teacher-only, both usable only before the game starts.
  const handleFinalizeCaptain = async (teamId: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await service.finalizeCaptainElection(roomCode, teacherSessionId, teamId)
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  const handleResetCaptain = async (teamId: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await service.resetCaptainElection(roomCode, teacherSessionId, teamId)
      setNotice('รีเซ็ตการเลือกตั้งหัวหน้าทีมแล้ว')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  // Item 6 follow-up: the boss-result popup modal is gone — the teacher now sees the same
  // inline "ศึกด่านชิงมนตราจบแล้ว" result screen the student does (rendered further down, in
  // place of the old small .boss-winner-pill), driven directly by room.bossAwaitingContinue via
  // the normal realtime room subscription. There is no local "is the popup open" state left to
  // manage or restore on refresh — a reload just re-renders off the current field value, exactly
  // like GamePage.
  //
  // iPad UX fix: this replaces the dashboard in place (same route, no navigation), so the browser
  // never resets scroll position on its own. A teacher who had scrolled down through a long
  // scoreboard/team list would land on the SAME scroll offset once this screen swaps in — on a
  // shorter page that can put the result and the "เล่นต่อ" button entirely above the fold,
  // contradicting "prominent." Scrolls to the top only on the false->true rising edge (never on
  // every render while still awaiting, so it can't fight the teacher's own scrolling while they're
  // reading the result) and never fires for any other state change, so ordinary scrolling
  // elsewhere on this page is untouched.
  const wasBossAwaitingContinue = useRef(false)
  useEffect(() => {
    const isAwaiting = roomState.data?.bossAwaitingContinue ?? false
    if (isAwaiting && !wasBossAwaitingContinue.current) {
      window.scrollTo(0, 0)
    }
    wasBossAwaitingContinue.current = isAwaiting
  }, [roomState.data?.bossAwaitingContinue])

  //
  // Guards a rapid double-click from firing two overlapping continueAfterBoss calls (the
  // service call is itself idempotent/safe either way — this just avoids a redundant request).
  // continuingBossRef is checked/set synchronously inside the handler (a ref read is never
  // stale the way a state read inside a closure could be); continuingBossBusy is the reactive
  // twin that actually drives the button's disabled/label state.
  const continuingBossRef = useRef(false)
  const [continuingBossBusy, setContinuingBossBusy] = useState(false)
  const handleContinueAfterBoss = (): void => {
    const room = roomState.data
    if (!room || continuingBossRef.current) return
    continuingBossRef.current = true
    setContinuingBossBusy(true)
    setError('')
    void service.continueAfterBoss(roomCode, teacherSessionId, room.currentRound)
      .catch((reason) => setError(friendlyError(reason)))
      .finally(() => { continuingBossRef.current = false; setContinuingBossBusy(false) })
  }

  // Pre-game stage transitions, both teacher-driven and both using the same double-click ref
  // guard shape as handleContinueAfterBoss. Neither is auto-fired by a polling effect — the
  // teacher decides when enough students have joined, and when the class has finished Recall.
  const advancingStageRef = useRef(false)
  const [advancingStageBusy, setAdvancingStageBusy] = useState(false)
  const runStageTransition = (transition: () => Promise<void>): void => {
    if (advancingStageRef.current) return
    advancingStageRef.current = true
    setAdvancingStageBusy(true)
    setError('')
    void transition()
      .catch((reason) => {
        // friendlyError collapses anything unrecognized into one generic connection message, which
        // is right for the teacher but leaves nothing to debug from. Log the raw reason too, so a
        // stage transition that fails on a real device is visible in the browser console instead
        // of only as friendly Thai text.
        console.error('[matana] stage transition failed', reason)
        setError(friendlyError(reason))
      })
      .finally(() => { advancingStageRef.current = false; setAdvancingStageBusy(false) })
  }
  // teamSetup -> preTest, once team setup (randomize/lock/captain/name/item) is complete. The
  // pre-test is self-paced with no timer, so nothing about the Recall duration is chosen here —
  // that control lives on the pre-test screen, where Recall starts.
  const handleStartPreTest = (): void => {
    // Kicked off synchronously inside the click, before the async service call — browsers only
    // allow play() from a real user gesture, and awaiting the transition first would lose it.
    backgroundMusic.start()
    runStageTransition(() => service.startPreTest(roomCode, teacherSessionId, assessmentSecondsPerQuestion))
  }
  const handleStartRecall = (): void => {
    backgroundMusic.start()
    runStageTransition(() => service.startRecall(roomCode, teacherSessionId, recallDurationSeconds))
  }
  // preTest -> recall. Everyone finished: go straight through. Anyone still unfinished: confirm
  // first, but never block — a single student must not be able to hold the whole class.
  const requestStartRecall = (): void => {
    if (preTestIncompleteCount > 0) {
      backgroundMusic.start()
      setConfirmAction('startRecall')
      return
    }
    handleStartRecall()
  }
  // Rows for the shared assessment stage view. Counts only — no answer content ever reaches the
  // teacher screen, which may be projected.
  const assessmentStudents = (which: 'pre' | 'post') => sortedPlayers.map((player) => {
    const answers = which === 'pre' ? player.preTestAnswers : player.postTestAnswers
    const room = roomState.data
    // Timed out is now PER STUDENT: each one's current question has its own window, derived from
    // when that question appeared for them.
    const timedOut = room != null && isAssessmentExpired(
      which === 'pre' ? preTestWindow(room, preTestProgressOf(player)) : postTestWindow(room, postTestProgressOf(player)),
      now,
    )
    const progress = which === 'pre' ? player.preTestProgress : player.postTestProgress
    return { id: player.id, displayName: player.displayName, progress, answeredCount: answers.length, timedOut }
  })
  // Opens the post-test. Until this runs the room is on the postTest STAGE but the test itself is
  // closed, so students wait and their answer writes are rejected.
  const handleStartPostTest = (): void =>
    runStageTransition(() => service.startPostTest(roomCode, teacherSessionId, assessmentSecondsPerQuestion))
  const handleStartSurvey = (): void => runStageTransition(() => service.startSurvey(roomCode, teacherSessionId))
  const handleCompleteRound = (): void => runStageTransition(() => service.completeRound(roomCode, teacherSessionId))
  // lobby -> teamSetup, once enough students have joined.
  const handleStartTeamSetup = (): void => runStageTransition(() => service.startTeamSetup(roomCode, teacherSessionId))

  // Item 7 (+ follow-up fix): teacher-side dramatic spell-event overlay — watches the same
  // magicEvents subscription the "ประวัติล่าสุด" log already reads, queues a popup for every
  // newly-observed event, deduped via sessionStorage with a "teacher:" prefix so this never
  // collides with the student toast's dedup keys for the same event id (see MagicPanel.tsx).
  //
  // Root-cause fix: this used to fire on 'applied'/'blocked' only — but those outcomes are set
  // by computeMagicResolution at QUESTION RESOLUTION time (advanceQuestion/closeQuestionEarly),
  // not at activation. That made the teacher's popup appear a full question-cycle after the
  // student had already seen their own 'queued'-triggered toast. 'queued' is the status written
  // atomically with the activation itself (see magicEvents' firestore.rules create rule), so
  // firing on it here is what makes "teacher popup appears immediately on activation" true —
  // matching the moment students' own toasts already fire on (MagicPanel keys the exact same
  // 'queued' status for power_surge/illusion/incoming-seal). 'blocked' is kept as a second,
  // genuinely later trigger — a shield defending is only known at resolution, so that dramatic
  // beat legitimately can't fire any earlier than this. 'applied' (a seal/surge resolving
  // without being blocked) intentionally gets no popup, mirroring the student side, which never
  // shows one for silent 'applied' resolution either — the 'queued' popup already announced it.
  const [spellEventQueue, setSpellEventQueue] = useState<Array<MagicEventCopy & { key: string }>>([])
  const [activeSpellEvent, setActiveSpellEvent] = useState<(MagicEventCopy & { key: string }) | null>(null)
  useEffect(() => {
    const relevant = magicEventsState.data.filter((event) => event.status === 'queued' || event.status === 'blocked')
    if (relevant.length === 0) return
    const sorted = [...relevant].sort((a, b) => a.createdAt - b.createdAt)
    const fresh: Array<MagicEventCopy & { key: string }> = []
    for (const event of sorted) {
      const popupKey = `teacher:${event.id}:${event.status}`
      if (hasShownMagicPopup(roomCode, popupKey)) continue
      const copy = buildTeacherSpellEventCopy(
        event,
        guardianDisplayName(event.sourceTeamId),
        event.targetTeamId ? guardianDisplayName(event.targetTeamId) : null,
      )
      fresh.push({ key: popupKey, ...copy })
      markMagicPopupShown(roomCode, popupKey)
    }
    if (fresh.length > 0) setSpellEventQueue((current) => [...current, ...fresh])
    // guardianDisplayName intentionally excluded from deps — it's recomputed every render off
    // stable data (teamNameById/guardianNameById) and including it would re-run this effect on
    // every render; only new magicEvents/roomCode should trigger a re-scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magicEventsState.data, roomCode])

  useEffect(() => {
    if (activeSpellEvent || spellEventQueue.length === 0) return
    setActiveSpellEvent(spellEventQueue[0])
    setSpellEventQueue((current) => current.slice(1))
  }, [activeSpellEvent, spellEventQueue])

  useEffect(() => {
    if (!activeSpellEvent) return
    const timeoutId = window.setTimeout(() => setActiveSpellEvent(null), 5_500)
    return () => window.clearTimeout(timeoutId)
  }, [activeSpellEvent])

  // Grimoire access point — purely local UI state, never touches room/service state, so opening
  // it can't pause the timer or alter game state (matches the same guarantee MagicPanel's own
  // grimoire trigger already gives students).
  const [grimoireOpen, setGrimoireOpen] = useState(false)

  // Item 6: team guardian name — teacher override/reset. Both are teacher-authorized regardless
  // of captain/election state (see firestore.rules' teamNames block).
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({})
  const handleOverrideTeamName = async (teamId: string): Promise<void> => {
    const draft = (nameDrafts[teamId] ?? '').trim()
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      await service.overrideTeamGuardianName(roomCode, teacherSessionId, teamId, draft)
      setNameDrafts((current) => ({ ...current, [teamId]: '' }))
      setNotice('ตั้งชื่อทีมแล้ว')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  const handleResetTeamName = async (teamId: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await service.resetTeamGuardianName(roomCode, teacherSessionId, teamId)
      setNotice('รีเซ็ตชื่อทีมแล้ว')
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setBusy(false)
    }
  }

  // Milestone 2.2: manual "ไปข้อถัดไปทันที" — shares the SAME advancingQuestion ref/debounce as
  // the automatic tick effect above, so a manual click and the automatic timer can never both
  // fire advanceQuestion for the same question within the 3s window (advanceQuestion itself is
  // also idempotent server-side via expectedQuestionIndex, but this avoids a redundant call and
  // a possible duplicate error toast).
  const handleAdvanceNow = (): void => {
    const room = roomState.data
    if (!room || room.status !== 'playing') return
    const questionKey = `${room.currentRound}-${room.currentQuestionIndex}`
    const recentlyAttempted = advancingQuestion.current.key === questionKey && Date.now() - advancingQuestion.current.attemptedAt < 3_000
    if (recentlyAttempted) return
    advancingQuestion.current = { key: questionKey, attemptedAt: Date.now() }
    setError('')
    void service.advanceQuestion(roomCode, teacherSessionId, room.currentQuestionIndex).catch((reason) => {
      advancingQuestion.current = { key: '', attemptedAt: 0 }
      setError(friendlyError(reason))
    })
  }

  // Milestone 2.2: "ปิดรับคำตอบและเฉลยทันที" — same debounce shape as handleAdvanceNow, using its
  // own ref so closing early and advancing to the next question never share (or clobber) one
  // another's stale/double-click guard.
  const handleCloseQuestionEarly = (): void => {
    const room = roomState.data
    if (!room || room.status !== 'playing') return
    const questionKey = `${room.currentRound}-${room.currentQuestionIndex}`
    const recentlyAttempted = closingQuestion.current.key === questionKey && Date.now() - closingQuestion.current.attemptedAt < 3_000
    if (recentlyAttempted) return
    closingQuestion.current = { key: questionKey, attemptedAt: Date.now() }
    setError('')
    void service.closeQuestionEarly(roomCode, teacherSessionId, room.currentQuestionIndex).catch((reason) => {
      closingQuestion.current = { key: '', attemptedAt: 0 }
      setError(friendlyError(reason))
    })
  }

  // The music spans the whole activity, so it is only ever torn down when the activity genuinely
  // ends: the teacher closes the room ("ยุติห้อง" -> status 'closed'). A finished round
  // (status 'completed') deliberately does NOT stop it — the podium and Learning Summary are
  // still part of the same session. Keyed on the transition into 'closed' so ordinary rerenders
  // while already closed never re-trigger it.
  const wasClosed = useRef(false)
  const stopBackgroundMusic = backgroundMusic.stop
  useEffect(() => {
    const closed = roomState.data?.status === 'closed'
    if (closed && !wasClosed.current) stopBackgroundMusic()
    wasClosed.current = closed
    // stopBackgroundMusic is a stable useCallback; depending on the whole controls object would
    // re-run this on every render, since the hook returns a fresh object each time.
  }, [roomState.data?.status, stopBackgroundMusic])

  const rememberRoom = (nextTeacherSessionId: string, nextRoomCode: string): void => {
    // A different room means a different activity — never carry the previous one's music into it.
    if (nextRoomCode !== roomCode) backgroundMusic.stop()
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
        if (!bossDurationValid) throw new Error(`ผู้ใช้:กำหนดเวลาต่อข้อของด่านชิงมนตราระหว่าง ${MIN_BOSS_SECONDS_PER_QUESTION} ถึง ${MAX_BOSS_SECONDS_PER_QUESTION} วินาที`)
        await service.startRoom(roomCode, teacherSessionId, questionDurationSeconds, bossDurationSeconds)
      }
      if (action === 'close') await service.closeRoom(roomCode, teacherSessionId)
      // Same call the direct (everyone-finished) path makes — the confirmation only gates it.
      if (action === 'startRecall') await service.startRecall(roomCode, teacherSessionId, recallDurationSeconds)
      setNotice(
        action === 'prepare'
          ? 'เตรียมภารกิจรอบใหม่แล้ว รายชื่อและทีมเดิมยังอยู่ครบ'
          : action === 'stop'
            ? 'หยุดเกมฉุกเฉินแล้ว ทุกคนกลับสู่ห้องรอและพร้อมเริ่มรอบใหม่'
            : action === 'start'
              ? `เริ่มภารกิจแล้ว ทุกคนมีเวลา ${questionDurationSeconds} วินาทีต่อข้อ`
              : action === 'startRecall'
                ? 'เริ่มทบทวนเรื่องราวแล้ว'
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
    // Shown only when someone is still unfinished. States the real consequence — those students
    // leave the pre/post comparison — rather than implying their work is lost, because it is not.
    startRecall: {
      title: 'เริ่มทบทวนเรื่องราว?',
      description: `ยังมีนักเรียน ${preTestIncompleteCount} คนทำแบบทดสอบไม่ครบ ข้อมูลของนักเรียนเหล่านี้จะไม่ถูกนำไปเปรียบเทียบคะแนนก่อน–หลัง ต้องการดำเนินการต่อหรือไม่?`,
      confirmLabel: 'ดำเนินการต่อ',
    },
  } as const

  // Room-level escape hatch for the two pre-team stage screens. Those screens replace the whole
  // dashboard — including the controls aside that normally holds "ยุติห้อง" — so without this the
  // teacher has no way to close or abandon a room once Recall has been reached. Deliberately only
  // the room-lifecycle actions: "หยุดเกม" is a status==='playing' concept and simply doesn't apply
  // while the room is still waiting.
  const StageRoomControls = () => (
    <div className="stage-room-controls">
      <button type="button" className="copy-button" onClick={() => setConfirmAction('close')} disabled={busy}>ยุติห้อง</button>
      <Link className="copy-button" to="/teacher/history">ประวัติห้อง</Link>
      {service.isDemo ? (
        <button type="button" className="copy-button" onClick={() => void createRoom()} disabled={busy}>สร้างห้องทดสอบใหม่</button>
      ) : null}
    </div>
  )

  // Captain / team-name rows. Built as an element list (not a nested component) so React keeps the
  // same instances across renders — a nested component would remount these inputs on every
  // keystroke and steal focus. Rendered either in the dashboard or inside the teamSetup column.
  const teamAdminRows = (roomState.data?.teams ?? []).map((team) => {
    const magic = magicByTeamId.get(team.id)
    const holderName = magic?.magicHolderPlayerId ? playerNameById.get(magic.magicHolderPlayerId) ?? '-' : '-'
    const memberCount = teamStatsById.get(team.id)?.memberCount ?? 0
    const votedCount = votedCountByTeam.get(team.id) ?? 0
    const guardianName = guardianNameById.get(team.id)
    return (
      <li key={team.id} className="team-admin-row">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <strong>{guardianName ?? team.name}</strong>
            {guardianName ? <small>{team.name}</small> : null}
          </span>
          {magic?.magicHolderPlayerId ? <span className="magic-badge magic-badge-captain">👑 {holderName}</span> : <span className="text-xs">ยังไม่มีหัวหน้าทีม</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            className="team-name-input"
            placeholder={guardianName ? 'ตั้งชื่อใหม่ (override)' : 'ตั้งชื่อทีม'}
            value={nameDrafts[team.id] ?? ''}
            maxLength={TEAM_GUARDIAN_NAME_MAX_LENGTH}
            onChange={(event) => setNameDrafts((current) => ({ ...current, [team.id]: event.target.value }))}
            aria-label={`ตั้งชื่อทีม ${team.name}`}
          />
          <button type="button" className="copy-button" onClick={() => void handleOverrideTeamName(team.id)} disabled={busy || !(nameDrafts[team.id] ?? '').trim()}>
            {guardianName ? 'แก้ไข' : 'ตั้งชื่อ'}
          </button>
          {guardianName ? (
            <button type="button" className="copy-button" onClick={() => void handleResetTeamName(team.id)} disabled={busy}>รีเซ็ตชื่อ</button>
          ) : null}
        </div>
        <small className="mt-1 block">{TEAM_GUARDIAN_NAME_MIN_LENGTH}-{TEAM_GUARDIAN_NAME_MAX_LENGTH} ตัวอักษร ไทย/อังกฤษ/ตัวเลข</small>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {!magic?.magicHolderPlayerId ? <span>โหวตแล้ว {votedCount}/{memberCount} คน</span> : null}
          {!magic?.magicHolderPlayerId ? (
            <button type="button" className="copy-button" onClick={() => void handleFinalizeCaptain(team.id)} disabled={busy || memberCount === 0}>
              สรุปผลหัวหน้าทีมตอนนี้
            </button>
          ) : null}
          <button type="button" className="copy-button" onClick={() => void handleResetCaptain(team.id)} disabled={busy}>
            รีเซ็ตการเลือกตั้ง
          </button>
        </div>
      </li>
    )
  })

  // Roster grouped by team, used once teams are locked. Presentation only — the grouping reads
  // player.teamId, it never assigns or reorders team membership. Teams keep room.teams order (the
  // same order "ทีม N" is numbered by); members sort by student number when numeric, otherwise
  // they keep their join order.
  const rosterGroups = (roomState.data?.teams ?? []).map((team, index) => ({
    id: team.id,
    name: team.name,
    guardianName: guardianNameById.get(team.id) ?? null,
    tone: index % TEAM_TONE_COUNT,
    // Readiness ONLY. This screen is projected, so revealing which item a team picked would hand
    // every opponent that information before it is ever used. hasAnyMagicItem returns a boolean
    // over the whole inventory, so there is no item type here to leak in the first place.
    hasChosenItem: hasAnyMagicItem(magicByTeamId.get(team.id)?.inventory ?? createEmptyMagicInventory()),
    members: sortedPlayers
      .filter((player) => player.teamId === team.id)
      .slice()
      .sort((a, b) => {
        const an = Number(a.studentNumber)
        const bn = Number(b.studentNumber)
        if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn
        return a.joinedAt - b.joinedAt
      }),
  }))
  const unassignedPlayers = sortedPlayers.filter((player) => !player.teamId)

  // Single readiness message for the pinned foot — same conditions, same order, same wording as
  // the dashboard's chain of hints; only the presentation is collapsed to one line.
  const warningMessage = !roomState.data
    ? null
    : !roomState.data.teamsLocked
      ? 'ต้องล็อกทีมก่อนจึงจะเริ่มภารกิจได้'
      : teamsWithoutCaptain.length > 0
        ? `ยังมี ${teamsWithoutCaptain.length} ทีมที่ยังไม่ได้เลือกหัวหน้าทีม กรุณาให้สมาชิกโหวตหรือสรุปผลก่อนเริ่มภารกิจ`
        : teamsWithoutName.length > 0
          ? `ยังมี ${teamsWithoutName.length} ทีมที่ยังไม่ได้ตั้งชื่อทีม กรุณาให้หัวหน้าทีมตั้งชื่อก่อนเริ่มภารกิจ`
          : teamsWithoutStartingItem.length > 0
            ? `ยังมี ${teamsWithoutStartingItem.length} ทีมที่ยังไม่ได้เลือกไอเทมเริ่มต้น กรุณาให้หัวหน้าทีมเลือกไอเทมก่อนเริ่มภารกิจ`
            : null

  // Header stage label. Every string here already exists in the UI's vocabulary for that stage —
  // the header just surfaces it, it does not invent a parallel naming scheme.
  const stageHeading = !roomState.data
    ? { title: 'ศูนย์บัญชาการครู', subtitle: 'ควบคุมภารกิจ' }
    : isLobbyPhase
      ? { title: 'ห้องรอครู', subtitle: 'รอนักเรียนเข้าร่วม' }
      : isPreTestPhase
        ? { title: 'แบบทดสอบก่อนเรียน', subtitle: 'กิจกรรมรายบุคคล' }
        : isRecallPhase
          ? { title: 'ทบทวนเรื่องราว', subtitle: 'กิจกรรมรายบุคคล' }
        : isTeamSetupPhase
          ? { title: 'จัดทีมผู้เล่น', subtitle: 'เตรียมความพร้อมก่อนเริ่มภารกิจ' }
          : isPostTestPhase
            ? { title: 'แบบทดสอบหลังเรียน', subtitle: 'กิจกรรมรายบุคคล' }
            : isSurveyPhase
              ? { title: 'แบบประเมินกิจกรรม', subtitle: 'กิจกรรมรายบุคคล' }
          : { title: 'ศูนย์บัญชาการ', subtitle: 'ควบคุมภารกิจ' }

  const currentDialog = confirmAction ? dialogContent[confirmAction] : null
  const broadcastMode = roomState.data?.status === 'playing'
  const finalMode = roomState.data?.status === 'completed' || roomState.data?.status === 'closed'
  // The evidence panel is for a round that actually finished. A room that was merely closed may
  // have been abandoned mid-activity, and its partial numbers would read as real results.
  const isCompletedRound = roomState.data?.status === 'completed'
  const showIndividualResults = finalMode && resultsTab === 'individual'

  return (
    <ScenePage compact className={`${broadcastMode ? 'teacher-broadcast-mode' : finalMode ? 'teacher-final-page' : ''} ${isTeamSetupPhase ? 'teacher-setup-page' : ''}`.trim()}>
      {/* Teacher-specific header: the approved title art instead of the generic brand mark, the
          current stage, and a live-subscription indicator. The dot reflects real state — the room
          snapshot is present and the subscription reported no error — rather than being decorative. */}
      <header className="teacher-topbar">
        <Link className="teacher-topbar-brand" to="/" aria-label="มัทนาต้องรอด หน้าแรก">
          <img src="/assets/home/home-logo.png" alt="" aria-hidden="true" />
          <span>
            <strong>มัทนาต้องรอด</strong>
            <small>เกมวรรณคดีไทย ม.5 มัทนะพาธา</small>
          </span>
        </Link>

        <div className="teacher-topbar-stage">
          <p className="teacher-topbar-title">{stageHeading.title}</p>
          <p className="teacher-topbar-subtitle">{stageHeading.subtitle}</p>
        </div>

        <div className="teacher-topbar-actions">
          {roomState.data ? (
            <span className={`teacher-live-pill ${roomState.error ? 'is-offline' : ''}`}>
              <i aria-hidden="true" />
              <span>
                <strong>{roomState.error ? 'การเชื่อมต่อขัดข้อง' : 'เชื่อมต่อเรียลไทม์'}</strong>
                <small>{service.isDemo ? 'โหมดสาธิต' : 'Firebase Realtime'}</small>
              </span>
            </span>
          ) : null}
          <Link className="teacher-topbar-home" to="/">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M4 10.8 12 4.5l8 6.3" />
              <path d="M6.3 12.4V19h11.4v-6.6" />
            </svg>
            <span>กลับหน้าแรก</span>
          </Link>
        </div>
      </header>
      {/* The pre-team stages render one self-contained screen, so the shell's generous bottom
          padding (sized for the long scrolling dashboard) is trimmed — without it the page
          overflows by exactly that padding on a 768px-tall iPad landscape viewport. */}
      <div className={`teacher-shell mx-auto w-full max-w-7xl flex-1 px-5 pt-4 sm:px-8 ${isLobbyPhase || isPreTestPhase || isRecallPhase || isTeamSetupPhase || isPostTestPhase || isSurveyPhase ? 'teacher-shell-stage' : 'pb-10'} ${isTeamSetupPhase ? 'teacher-shell-setup' : ''}`}>
        {/* Compact top branding for the dedicated single-viewport Recall screen: the full hero
            header (big heading + descriptive subtitle) collapses to one line, so branding + room
            bar + Recall view all fit one viewport together with no scrolling. */}
        {/* The room-control header only serves the pre-game stages (share the code, watch people
            arrive, set up teams). Once Main starts it is dead weight on a screen the class is
            watching, so it — and the room bar below — are dropped entirely for main/boss/result,
            letting the live content start at the top of the page instead. */}
        {!showRoomControls ? null : isRecallPhase ? (
          <div className="teacher-intro-compact mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="eyebrow m-0">ศูนย์บัญชาการครู · ควบคุมภารกิจ</p>
            {service.isDemo ? <span className="demo-mode-pill"><i />โหมดสาธิต</span> : <span className="live-mode-pill"><i />Firebase realtime</span>}
          </div>
        ) : (
          <div className="teacher-intro mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="eyebrow">ศูนย์บัญชาการครู</p>
              <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">ควบคุมภารกิจ</h1>
              <p className="mt-2 text-[#cfc7bb]">สร้างห้อง จัดทีม ติดตามทุกคน และเริ่มรอบพร้อมกันจากหน้าจอนี้</p>
            </div>
            {service.isDemo ? <span className="demo-mode-pill"><i />โหมดสาธิต</span> : <span className="live-mode-pill"><i />Firebase realtime</span>}
          </div>
        )}

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
            {/* Reachable with no active room on purpose: the usual reason to open this is to
                print or export a class that finished days ago. */}
            <Link className="secondary-button mx-auto mt-3 flex w-full max-w-sm justify-center" to="/teacher/history">ประวัติห้อง</Link>
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
            {showRoomControls ? (
            <section className="teacher-room-bar">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#b6ab9e]">รหัสห้อง</p>
                <div className="mt-1 flex items-center gap-3">
                  <strong className="room-code">{roomCode}</strong>
                  <button className="copy-button" onClick={() => void copyCode()} aria-label="คัดลอกรหัสห้อง">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
                    </svg>
                    คัดลอก
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-5 sm:flex sm:gap-8">
                <div><small>สถานะห้อง</small><StatusPill status={roomState.data.status} /></div>
                <div><small>รอบที่</small><strong className="block text-2xl text-[#f2d58d]">{roomState.data.currentRound}</strong></div>
                {isRecallPhase ? (
                  <div><small>ระยะ</small><strong className="block text-2xl text-[#f2d58d]">ทบทวนเรื่องราว ({recallCompletedCount}/{sortedPlayers.length})</strong></div>
                ) : roomState.data.status === 'playing' && isBossPhase ? (
                  <>
                    <div><small>ศึกด่านชิงมนตรา</small><strong className="block text-2xl text-[#f2d58d]">{roomState.data.bossQuestionIndex + 1}/3</strong></div>
                    <div><small>{bossRevealRemainingMs > 0 ? 'กำลังแสดงผล' : 'เวลาคงเหลือ'}</small><strong className="block text-2xl text-[#f2d58d]">{bossRevealRemainingMs > 0 ? formatCountdown(bossRevealRemainingMs) : formatCountdown(bossRemainingMs)}</strong></div>
                  </>
                ) : roomState.data.status === 'playing' ? (
                  <>
                    <div><small>คำถาม</small><strong className="block text-2xl text-[#fff7df]">{Math.min(roomState.data.currentQuestionIndex + 1, 10)}/10</strong></div>
                    <div><small>{revealRemainingMs > 0 ? 'กำลังแสดงผล' : 'เวลาคงเหลือ'}</small><strong className="block text-2xl text-[#f2d58d]">{revealRemainingMs > 0 ? formatCountdown(revealRemainingMs) : formatCountdown(remainingMs)}</strong></div>
                  </>
                ) : null}
                <div>
                  <small>ผู้เล่นทั้งหมด</small>
                  <strong className="room-bar-metric">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <circle cx="9" cy="8.5" r="3.2" /><path d="M2.8 19c0-3.2 2.8-5.2 6.2-5.2s6.2 2 6.2 5.2" />
                      <path d="M16.2 6.2a3.2 3.2 0 0 1 0 6M17.6 14.2c2.2.6 3.6 2.3 3.6 4.8" />
                    </svg>
                    {sortedPlayers.length} คน
                  </strong>
                </div>
                <div>
                  <small>ทีมทั้งหมด</small>
                  <strong className="room-bar-metric">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <path d="M12 3.5 19 6v6c0 4-3 7-7 8.5C8 19 5 16 5 12V6z" />
                    </svg>
                    {roomState.data.teams.length} ทีม
                  </strong>
                </div>
              </div>
            </section>
            ) : null}

            {(error || (notice && !broadcastMode && !finalMode)) ? <div className={error ? 'error-message mt-4' : 'success-message mt-4'} role="status">{error || notice}</div> : null}

            {/* Learning Layer teacher UX fix: while phase === 'recall', the normal long dashboard
                (scoreboard, team setup, magic history — everything below) is hidden entirely in
                favor of this dedicated single-screen control view, so the teacher never has to
                scroll to see "how many students are done" or to start Main. Three states, purely
                derived from already-existing data (sortedPlayers.length / recallCompletedCount /
                classLearningSummary) — no new Recall scoring or data logic. */}
            {/* Stage 'lobby' — students join as individuals, no team concept is presented at all
                (team count deliberately isn't offered here; it belongs to the teamSetup stage,
                the very next one). The teacher decides when enough students have arrived. */}
            {isLobbyPhase ? (
              <div className="lobby-stage" aria-live="polite">
                <section className="lobby-command">
                  <p className="stage-badge">ขั้นที่ 1 · รวมผู้เรียน</p>
                  <h2 className="lobby-command-title">รอนักเรียนเข้าร่วม</h2>
                  <div className="rose-rule" aria-hidden="true" />

                  <p className="lobby-count-label">จำนวนนักเรียนที่เข้าร่วม</p>
                  <p className="lobby-count">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <circle cx="9" cy="8.5" r="3.2" /><path d="M2.8 19c0-3.2 2.8-5.2 6.2-5.2s6.2 2 6.2 5.2" />
                      <path d="M16.2 6.2a3.2 3.2 0 0 1 0 6M17.6 14.2c2.2.6 3.6 2.3 3.6 4.8" />
                    </svg>
                    <strong>{sortedPlayers.length}</strong> คน
                  </p>

                  <p className="lobby-helper">
                    แชร์รหัสห้องให้นักเรียนเพื่อเข้าร่วม<br />
                    รายชื่อนักเรียนจะแสดงขึ้นแบบเรียลไทม์<br />
                    <span className="lobby-helper-accent">ขั้นนี้ยังไม่ได้จัดทีม</span>
                  </p>

                  <div className="lobby-divider" aria-hidden="true" />

                  {/* Both timing controls live HERE, before anything starts: the assessment total
                      budget (used by BOTH the pre-test and the post-test) and Recall's separate
                      per-item timing. Both are entered in SECONDS so two adjacent number inputs
                      cannot mean different units. Neither appears on an assessment screen, where a
                      per-item control would be mistaken for the test's own clock. */}
                  <SettingStepper
                    id="assessment-duration"
                    label="เวลาต่อข้อ (ก่อนเรียน/หลังเรียน)"
                    helper={`${MIN_ASSESSMENT_SECONDS_PER_QUESTION}–${MAX_ASSESSMENT_SECONDS_PER_QUESTION} วินาทีต่อข้อ • ทุกข้อได้เวลาเท่ากัน • ใช้ค่าเดียวกันทั้งแบบทดสอบก่อนเรียนและหลังเรียน`}
                    value={assessmentDurationValue}
                    onChange={setAssessmentDurationValue}
                    min={MIN_ASSESSMENT_SECONDS_PER_QUESTION}
                    max={MAX_ASSESSMENT_SECONDS_PER_QUESTION}
                  />

                  <SettingStepper
                    id="recall-duration"
                    label="เวลาต่อข้อ (ทบทวนเรื่องราว)"
                    helper={`${MIN_RECALL_SECONDS_PER_ITEM}–${MAX_RECALL_SECONDS_PER_ITEM} วินาทีต่อข้อ • ใช้กับทั้ง 5 ข้อ`}
                    value={recallDurationValue}
                    onChange={setRecallDurationValue}
                    min={MIN_RECALL_SECONDS_PER_ITEM}
                    max={MAX_RECALL_SECONDS_PER_ITEM}
                  />
                  <button
                    type="button"
                    className="stage-cta"
                    onClick={handleStartTeamSetup}
                    disabled={advancingStageBusy || sortedPlayers.length === 0 || !assessmentDurationValid || !recallDurationValid}
                  >
                    {advancingStageBusy ? 'กำลังดำเนินการ...' : 'เริ่มจัดทีมผู้เล่น'}
                  </button>

                  {sortedPlayers.length === 0 ? (
                    <p className="recall-command-hint">ต้องมีอย่างน้อย 1 คนจึงจะเริ่มได้</p>
                  ) : null}

                  <p className="lobby-footnote">
                    <span className="lobby-footnote-mark" aria-hidden="true">i</span>
                    แนะนำ: ตรวจสอบรายชื่อนักเรียนทุกคนก่อนเริ่มเกม
                  </p>

                  <StageRoomControls />
                </section>

                <section className="lobby-roster">
                  <h3 className="lobby-roster-title">
                    นักเรียนที่เข้าร่วม
                    <span className="lobby-roster-count">{sortedPlayers.length} คน</span>
                  </h3>
                  {sortedPlayers.length > 0 ? (
                    <ul className="lobby-roster-list">
                      {sortedPlayers.map((player) => (
                        <li key={player.id} className="lobby-roster-item">
                          <span className="lobby-roster-avatar" aria-hidden="true">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                              <circle cx="12" cy="9.2" r="3.4" />
                              <path d="M5.4 19.4c0-3.3 2.9-5.4 6.6-5.4s6.6 2.1 6.6 5.4" />
                            </svg>
                          </span>
                          <span className="lobby-roster-name">{player.displayName}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="lobby-roster-empty">ยังไม่มีนักเรียนเข้าร่วม</p>
                  )}
                </section>
              </div>
            ) : null}

            {/* Stage 'preTest' — a minimal progress board. Deliberately shows NO answers, no
                correctness and no scores: the pre-test is a measurement, and a live answer feed
                would let the room see the test. Only "who is still working" is surfaced, which is
                all the teacher needs to decide when to move on. */}
            {isPreTestPhase ? (
              <TeacherAssessmentStage
                eyebrow="ขั้นที่ 1 · แบบทดสอบก่อนเรียน"
                title="แบบทดสอบก่อนเรียน"
                students={assessmentStudents('pre')}
                completedCount={preTestCompletedCount}
                startedAt={roomState.data.preTestStartedAt}
                secondsPerQuestion={roomState.data.assessmentSecondsPerQuestion}
                startLabel="เริ่มแบบทดสอบก่อนเรียน"
                onContinue={requestStartRecall}
                continueLabel="เริ่มทบทวนเรื่องราว"
                continueHint="ยังมีนักเรียนทำไม่ครบ — เริ่มต่อได้ คำตอบที่บันทึกไว้จะไม่หาย"
                busy={advancingStageBusy}
                footer={<StageRoomControls />}
              />
            ) : null}

            {/* Stage 'postTest' — the same minimal progress board the pre-test uses. No answers,
                no correctness, no scores: this is a measurement, and the class must not see the
                test. The live scoreboard dashboard is suppressed for the same reason. */}
            {isPostTestPhase ? (
              <TeacherAssessmentStage
                eyebrow="ขั้นสุดท้าย · แบบทดสอบหลังเรียน"
                title="แบบทดสอบหลังเรียน"
                students={assessmentStudents('post')}
                completedCount={postTestCompletedCount}
                startedAt={roomState.data.postTestStartedAt}
                secondsPerQuestion={roomState.data.assessmentSecondsPerQuestion}
                onStart={handleStartPostTest}
                startLabel="เริ่มแบบทดสอบหลังเรียน"
                onContinue={handleStartSurvey}
                continueLabel="เริ่มแบบประเมินกิจกรรม"
                continueHint="ยังมีนักเรียนทำไม่ครบ — ไปต่อได้ คำตอบที่บันทึกไว้จะไม่หาย"
                busy={advancingStageBusy}
                footer={<StageRoomControls />}
              />
            ) : null}

            {/* Stage 'survey' — the same minimal progress board. Individual responses are never
                shown live: this is an opinion survey, and displaying answers to the room would
                discourage honest ones. */}
            {isSurveyPhase ? (
              <section className="recall-command-view" aria-live="polite">
                <p className="eyebrow">ขั้นสุดท้าย · แบบประเมินกิจกรรม</p>
                <h2 className="recall-command-title">แบบประเมินกิจกรรม</h2>
                <p className="recall-command-count">
                  เสร็จแล้ว {surveyCompletedCount} / {sortedPlayers.length} คน
                </p>
                <div className="recall-command-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={sortedPlayers.length} aria-valuenow={surveyCompletedCount}>
                  <i style={{ width: `${sortedPlayers.length > 0 ? (surveyCompletedCount / sortedPlayers.length) * 100 : 0}%` }} />
                </div>

                <ul className="recall-player-chips" aria-label="สถานะรายบุคคล">
                  {sortedPlayers.map((player) => {
                    const done = player.surveyResponses.length >= SURVEY_ITEM_COUNT
                    return (
                      <li key={player.id} className={`recall-player-chip ${done ? 'recall-player-chip-done' : ''}`}>
                        <span>{player.displayName}</span>
                        <b>{done ? 'เสร็จแล้ว' : 'กำลังทำ'}</b>
                      </li>
                    )
                  })}
                </ul>

                {/* Ends the round. Snapshots this round's history first (see completeRound), so
                    pre-test / post-test / survey data is durable the moment this is pressed. */}
                <button
                  type="button"
                  className="primary-button recall-start-main-button mt-5"
                  onClick={handleCompleteRound}
                  disabled={advancingStageBusy}
                >
                  {advancingStageBusy ? 'กำลังดำเนินการ...' : 'สรุปผลกิจกรรม'}
                </button>
                {surveyCompletedCount < sortedPlayers.length ? (
                  <p className="recall-command-hint">ยังมีนักเรียนทำไม่ครบ — สรุปผลได้ คำตอบที่บันทึกไว้จะไม่หาย</p>
                ) : null}

                <StageRoomControls />
              </section>
            ) : null}

            {/* Stage 'teamSetup' — roster on the left, team/timing settings on the right. The
                settings, the boss timer, the readiness warnings and the start button are all the
                existing controls, relocated here; the dashboard's duplicate copy of them is
                suppressed below while this stage is active. */}
            {isTeamSetupPhase ? (
              <div className="setup-stage" aria-live="polite">
                <section className="cream-panel setup-roster">
                  <h3 className="cream-panel-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <circle cx="9" cy="8.5" r="3.2" /><path d="M2.8 19c0-3.2 2.8-5.2 6.2-5.2s6.2 2 6.2 5.2" />
                      <path d="M16.2 6.2a3.2 3.2 0 0 1 0 6M17.6 14.2c2.2.6 3.6 2.3 3.6 4.8" />
                    </svg>
                    รายชื่อผู้เข้าร่วม
                    <span className="cream-count-pill">{sortedPlayers.length} คน</span>
                  </h3>
                  {/* Once teams are locked the mixed list is replaced by per-team groups, so the
                      teacher can never mistake one team's member for another's. Grouping is
                      presentation only — no assignment logic runs here. */}
                  {roomState.data.teamsLocked ? (
                    <div className="setup-groups">
                      {rosterGroups.map((group) => (
                        <section key={group.id} className={`setup-group team-tone-${group.tone}`}>
                          <h4 className="setup-group-head">
                            <i className="team-tone-dot" aria-hidden="true" />
                            <span>{group.guardianName ?? group.name}</span>
                            {group.guardianName ? <small>{group.name}</small> : null}
                            <span className="setup-group-count">{group.members.length} คน</span>
                            {group.hasChosenItem ? (
                              <span className="setup-group-ready" title="ทีมนี้เลือกไอเท็มเริ่มต้นแล้ว">เลือกไอเท็มแล้ว ✓</span>
                            ) : null}
                          </h4>
                          <ul className="setup-group-list">
                            {group.members.map((player) => {
                              // Captain comes from the persisted magicHolderPlayerId for this
                              // team — never from list order.
                              const isCaptain = magicByTeamId.get(group.id)?.magicHolderPlayerId === player.id
                              return (
                                <li key={player.id}>
                                  <span className="setup-group-name">
                                    {isCaptain ? (
                                      <span className="setup-group-crown" title="หัวหน้าทีม" aria-label="หัวหน้าทีม">👑</span>
                                    ) : null}
                                    {player.displayName}
                                    {isCaptain ? <small className="setup-group-captain-tag">(หัวหน้าทีม)</small> : null}
                                  </span>
                                  <span className="setup-group-number">เลขที่ {player.studentNumber}</span>
                                </li>
                              )
                            })}
                            {group.members.length === 0 ? <li className="setup-group-empty">ยังไม่มีสมาชิก</li> : null}
                          </ul>
                        </section>
                      ))}
                      {unassignedPlayers.length > 0 ? (
                        <section className="setup-group setup-group-unassigned">
                          <h4 className="setup-group-head">
                            <span>ยังไม่ได้จัดทีม</span>
                            <span className="setup-group-count">{unassignedPlayers.length} คน</span>
                          </h4>
                          <ul className="setup-group-list">
                            {unassignedPlayers.map((player) => (
                              <li key={player.id}>
                                <span className="setup-group-name">{player.displayName}</span>
                                <span className="setup-group-number">เลขที่ {player.studentNumber}</span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </div>
                  ) : (
                  <div className="setup-table-wrap">
                    <table className="setup-table">
                      <thead>
                        <tr><th>ลำดับ</th><th>ชื่อผู้เล่น</th><th>เลขที่นักเรียน</th><th>ทีมที่อยู่</th></tr>
                      </thead>
                      <tbody>
                        {sortedPlayers.map((player, index) => {
                          const teamName = player.teamId ? teamNameById.get(player.teamId) : null
                          const tone = player.teamId ? teamToneById.get(player.teamId) : undefined
                          return (
                            <tr key={player.id}>
                              <td><span className="setup-row-index">{index + 1}</span></td>
                              <td className="setup-row-name">{player.displayName}</td>
                              <td className="setup-row-number">{player.studentNumber}</td>
                              <td>
                                <span className={teamName ? `setup-team-tag is-assigned team-tone-${tone ?? 0}` : 'setup-team-tag'}>
                                  {/* The dot repeats the colour as a shape, so the team is still
                                      distinguishable without relying on hue alone. */}
                                  {teamName ? <i className="team-tone-dot" aria-hidden="true" /> : null}
                                  {teamName ?? 'ยังไม่ได้จัดทีม'}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {sortedPlayers.length === 0 ? <p className="setup-empty">ยังไม่มีนักเรียนเข้าร่วม</p> : null}
                  </div>
                  )}
                  <p className="cream-footnote">
                    <span className="cream-footnote-mark" aria-hidden="true">i</span>
                    นักเรียนสามารถเข้าร่วมได้เรื่อย ๆ รายชื่อจะอัปเดตแบบเรียลไทม์
                  </p>
                </section>

                <section className="cream-panel setup-settings">
                  <div className="setup-settings-scroll">
                  <h3 className="cream-panel-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                      <circle cx="12" cy="12" r="3.2" />
                      <path d="M12 4.2v2M12 17.8v2M4.2 12h2M17.8 12h2M6.5 6.5l1.4 1.4M16.1 16.1l1.4 1.4M17.5 6.5l-1.4 1.4M7.9 16.1l-1.4 1.4" />
                    </svg>
                    ตั้งค่าการจัดทีม
                  </h3>

                  <div className="setup-field">
                    <div className="setup-field-label">
                      <strong>จำนวนทีม</strong>
                      <small>จำนวนทีมที่จะจัดให้นักเรียน</small>
                    </div>
                    <NumberStepper
                      id="team-count"
                      label="จำนวนทีม"
                      value={teamCountValue}
                      onChange={setTeamCountValue}
                      min={1}
                      max={20}
                      disabled={roomState.data.teamsLocked}
                    />
                  </div>

                  <div className="setup-field">
                    <div className="setup-field-label">
                      <strong>สุ่มทีม</strong>
                      <small>จัดทีมให้นักเรียนแบบสุ่ม</small>
                    </div>
                    <button className="setup-action is-primary" onClick={() => void randomizeTeams()} disabled={busy || sortedPlayers.length === 0 || !teamCountValid || roomState.data.teamsLocked}>
                      สุ่มทีม
                    </button>
                  </div>

                  <div className="setup-field">
                    <div className="setup-field-label">
                      <strong>ล็อกทีม</strong>
                      <small>ล็อกทีมที่จัดไว้แล้ว</small>
                    </div>
                    <button className="setup-action is-dark" onClick={() => void toggleTeamLock()} disabled={busy || (!roomState.data.teamsLocked && (roomState.data.teams.length === 0 || unassignedCount > 0))}>
                      {roomState.data.teamsLocked ? 'ปลดล็อกทีม' : 'ล็อกทีม'}
                    </button>
                  </div>

                  {!roomState.data.teamsLocked && roomState.data.teams.length > 0 && unassignedCount > 0 ? (
                    <p className="setup-warning">มีผู้เล่น {unassignedCount} คนยังไม่ได้จัดทีม กรุณาสุ่มทีมอีกครั้งก่อนล็อก</p>
                  ) : null}

                  <div className="setup-field">
                    <div className="setup-field-label">
                      <strong>เวลาต่อคำถาม</strong>
                      <small>เวลาต่อ 1 คำถาม</small>
                    </div>
                    <NumberStepper
                      id="question-duration"
                      label="เวลาต่อคำถาม"
                      value={durationValue}
                      onChange={setDurationValue}
                      min={durationUnit === 'seconds' ? 5 : 1}
                      max={durationUnit === 'seconds' ? 600 : 10}
                    />
                  </div>
                  <div className="setup-unit-row">
                    <label htmlFor="duration-unit">หน่วยเวลา</label>
                    <select id="duration-unit" value={durationUnit} onChange={(event) => { const nextUnit = event.target.value as 'seconds' | 'minutes'; setDurationUnit(nextUnit); setDurationValue(nextUnit === 'minutes' ? '1' : '30') }}>
                      <option value="seconds">วินาที</option>
                      <option value="minutes">นาที</option>
                    </select>
                    <small>5 วินาที ถึง 10 นาที ทุกคนใช้เวลาเท่ากัน</small>
                  </div>

                  <div className="setup-field">
                    <div className="setup-field-label">
                      <strong>เวลาต่อข้อ (ด่านชิงมนตรา)</strong>
                      <small>{MIN_BOSS_SECONDS_PER_QUESTION}-{MAX_BOSS_SECONDS_PER_QUESTION} วินาที · ใช้กับทั้ง 3 ข้อ</small>
                    </div>
                    <NumberStepper
                      id="boss-duration"
                      label="เวลาต่อข้อด่านชิงมนตรา"
                      value={bossDurationValue}
                      onChange={setBossDurationValue}
                      min={MIN_BOSS_SECONDS_PER_QUESTION}
                      max={MAX_BOSS_SECONDS_PER_QUESTION}
                    />
                  </div>

                  {/* The per-team admin block (name override, name reset, captain-election reset,
                      captain badges) used to sit here and duplicated what the roster on the left
                      already conveys. Removed from THIS screen only — teamAdminRows and every
                      handler behind it are untouched and still render on the dashboard, so no
                      team, captain or naming capability was removed from the app. */}

                  {roomState.data.teams.length > 0 ? (
                    <button type="button" className="setup-grimoire" onClick={() => setGrimoireOpen(true)}>
                      📜 คัมภีร์มนตรา
                    </button>
                  ) : null}

                  <div className="setup-tips">
                    <p className="setup-tips-title">คำแนะนำสำหรับครู</p>
                    <ul>
                      <li>กำหนดจำนวนทีมที่ต้องการ</li>
                      <li>คลิก “สุ่มทีม” เพื่อจัดทีมให้นักเรียนอัตโนมัติ</li>
                      <li>เมื่อล็อกทีมแล้ว จะไม่สามารถเปลี่ยนแปลงได้</li>
                      <li>ตั้งค่าเวลาต่อคำถามสำหรับการเล่นจริง</li>
                    </ul>
                  </div>
                  </div>

                  {/* Pinned foot: the start CTA and the room control stay visible whatever the
                      column above is scrolled to. This CTA now leaves team setup for the
                      pre-test, not for Main directly — Main's own timer/readiness gate has moved
                      to the Recall stage screen below, the step that now sits right before it. */}
                  <div className="setup-foot">
                    {warningMessage ? <p className="setup-warning">{warningMessage}</p> : null}
                    <button
                      className="stage-cta setup-start"
                      onClick={handleStartPreTest}
                      disabled={busy || advancingStageBusy || sortedPlayers.length === 0 || !roomState.data.teamsLocked || teamsWithoutCaptain.length > 0 || teamsWithoutName.length > 0 || teamsWithoutStartingItem.length > 0}
                    >
                      {busy || advancingStageBusy ? 'กำลังดำเนินการ...' : 'เริ่มแบบทดสอบก่อนเรียน'}
                    </button>
                    <StageRoomControls />
                  </div>
                </section>
              </div>
            ) : null}

            {/* Stage 'recall' — one dedicated viewport. Team, captain and item state already
                exist by this point (team setup ran before the pre-test) but are deliberately not
                surfaced here — this screen stays focused on individual recall progress, with no
                team-management surface, so there is no second decision point for teams. */}
            {isRecallPhase ? (
              <section className="recall-command-view" aria-live="polite">
                <p className="eyebrow">ขั้นที่ 2 · กิจกรรมรายบุคคล</p>
                <h2 className="recall-command-title">ทบทวนเรื่องราวมัทนา</h2>
                {recallCompletedCount < sortedPlayers.length ? (
                  <>
                    <p className="recall-command-status">กำลังรื้อฟื้นเรื่องราว</p>
                    <p className="recall-command-count">เสร็จแล้ว {recallCompletedCount} / {sortedPlayers.length} คน</p>
                    <div className="recall-command-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={sortedPlayers.length} aria-valuenow={recallCompletedCount}>
                      <i style={{ width: `${sortedPlayers.length > 0 ? (recallCompletedCount / sortedPlayers.length) * 100 : 0}%` }} />
                    </div>
                  </>
                ) : (
                  <>
                    <p className="recall-command-status recall-command-status-done">ทุกคนทบทวนเรื่องราวเรียบร้อยแล้ว</p>
                    <p className="recall-command-count">{recallCompletedCount} / {sortedPlayers.length} คน</p>
                    <div className="recall-command-progress-bar recall-command-progress-bar-full">
                      <i style={{ width: '100%' }} />
                    </div>
                    <p className="recall-command-baseline">ตอบถูกเฉลี่ย: <strong>{classRecallSummary.averageCorrectCount.toFixed(1)}/{classRecallSummary.totalCount}</strong></p>
                  </>
                )}
                {/* Compact per-player progress — the "this is still an individual phase" signal,
                    and what keeps this screen from reading as empty while students work. */}
                <ul className="recall-player-chips" aria-label="ความคืบหน้ารายบุคคล">
                  {sortedPlayers.map((player) => {
                    const done = player.recallAnswers.length >= RECALL_QUESTION_COUNT
                    return (
                      <li key={player.id} className={`recall-player-chip ${done ? 'recall-player-chip-done' : ''}`}>
                        <span>{player.displayName}</span>
                        <b>{player.recallAnswers.length}/{RECALL_QUESTION_COUNT}</b>
                      </li>
                    )
                  })}
                </ul>
                {/* Gated on the SHARED sequence finishing all 5 questions — not on every student
                    having personally answered. The room advances on its own timer, so this
                    unlocks the moment the last question's reveal ends, regardless of who
                    answered what. This is also where Main's own timer/readiness gate now lives —
                    team setup already completed before the pre-test, so nothing left to check
                    here but the duration settings and the Recall sequence itself. */}
                <button
                  type="button"
                  className="primary-button recall-start-main-button mt-6"
                  onClick={requestStart}
                  disabled={busy || sortedPlayers.length === 0 || !recallSequenceFinished || !durationValid || !bossDurationValid || !roomState.data.teamsLocked || teamsWithoutCaptain.length > 0 || teamsWithoutName.length > 0 || teamsWithoutStartingItem.length > 0}
                >
                  {busy ? 'กำลังดำเนินการ...' : roomState.data.currentRound === 1 ? 'เริ่มภารกิจพร้อมจับเวลา' : 'เริ่มรอบใหม่พร้อมจับเวลา'}
                </button>
                {!recallSequenceFinished ? (
                  <p className="recall-command-hint">
                    กำลังทำข้อ {Math.min(recallQuestionIndex + 1, RECALL_QUESTION_COUNT)} จาก {RECALL_QUESTION_COUNT} — เริ่มภารกิจได้เมื่อครบทุกข้อ
                  </p>
                ) : null}
                <StageRoomControls />
              </section>
            ) : null}

            {/* Item 6 follow-up: replaces the old popup modal. While bossAwaitingContinue is
                true, this prominent inline screen — the same BossResultDetails content the
                student sees — takes over with a big "เล่นต่อ" button; the room stays paused
                (timer stopped, no next-question entry for any client) until the teacher presses
                it. A refresh lands right back here for free (driven by the normal room
                subscription, no separate "is this open" state). Once continued, this collapses
                back to the small persistent history pill for the rest of the round, exactly as
                before. */}
            {roomState.data.bossAwaitingContinue && roomState.data.bossWinner ? (
              <section className="boss-result-inline mt-4" aria-live="polite">
                <p className="eyebrow">🏆 ผู้พิชิตด่านชิงมนตรา</p>
                <h2 className="mt-2 text-center text-2xl font-semibold sm:text-3xl">ศึกด่านชิงมนตราจบแล้ว!</h2>
                <BossResultDetails
                  winner={roomState.data.bossWinner}
                  guardianTeamName={roomState.data.bossWinner.teamId ? guardianDisplayName(roomState.data.bossWinner.teamId) : roomState.data.bossWinner.teamName ?? '-'}
                />
                <button type="button" className="primary-button boss-result-continue-button mt-5" onClick={handleContinueAfterBoss} disabled={continuingBossBusy} autoFocus>
                  {continuingBossBusy ? 'กำลังดำเนินการ...' : 'เล่นต่อ'}
                </button>
              </section>
            ) : roomState.data.bossAwaitingContinue ? (
              // No-winner case — nobody answered a single boss question correctly, so no reward
              // was granted. The round still pauses and still requires an explicit continue.
              <section className="boss-result-inline mt-4" aria-live="polite">
                <h2 className="text-center text-2xl font-semibold sm:text-3xl">ศึกด่านชิงมนตราจบแล้ว!</h2>
                <p className="mx-auto mt-2 max-w-md text-center text-[#d8d1c5]">ไม่มีผู้พิชิตด่านในรอบนี้ — ไม่มีทีมใดได้รับไอเทม</p>
                <button type="button" className="primary-button boss-result-continue-button mt-5" onClick={handleContinueAfterBoss} disabled={continuingBossBusy} autoFocus>
                  {continuingBossBusy ? 'กำลังดำเนินการ...' : 'เล่นต่อ'}
                </button>
              </section>
            ) : roomState.data.bossCompleted && roomState.data.bossWinner ? (
              // This is a teacher-facing, team-oriented screen, so the persistent identity pill
              // names the winning TEAM, never the individual who happened to win the boss round.
              // guardianDisplayName already prefers the team's chosen guardian name and falls back
              // to the generic "ทีม N" label; bossWinner.teamName is the last resort for the rare
              // case where the winner carried no teamId. The podium below still lists members.
              <p className="boss-winner-pill mt-4" aria-live="polite">
                🏆 ทีม {roomState.data.bossWinner.teamId
                  ? guardianDisplayName(roomState.data.bossWinner.teamId)
                  : roomState.data.bossWinner.teamName ?? '-'}
              </p>
            ) : null}

            {/* The entire normal dashboard body (podium, learning summary, scoreboard, team
                setup, magic history) is hidden during the pre-test/recall stages — the dedicated
                single-viewport screen above is the only thing shown, so there is nothing left
                below it to force scrolling. It returns in full, unchanged, at the 'teamSetup'
                stage, which now runs BEFORE the pre-test/recall stages hidden here. */}
            {/* Every stage with a dedicated single-viewport screen belongs in this list. The
                three assessment stages were all added AFTER this guard was written, so each one
                rendered its stage screen with the entire dashboard appended below it — pushing
                the stage's own CTA below the fold on a projector/tablet, which read as the
                teacher having no action available at all. */}
            {!isLobbyPhase && !isPreTestPhase && !isRecallPhase && !isPostTestPhase && !isSurveyPhase ? (
              <>
            {/* Teacher final-result screen. Replaces the old oversized victory podium + stacked
                learning-summary panel with one command centre: compact hero, four tabs, and room
                controls that stay visible without scrolling. Purely presentational — every figure
                is passed in already-computed (team ranking, the single shared evidence
                aggregation, the recall summary), so this screen cannot drift from the printout or
                the workbook, and no new score is derived here. */}
            {finalMode ? (
              <TeacherResultCommandCenter
                round={roomState.data.currentRound}
                roomStatus={roomState.data.status}
                competitionStats={competitionStats}
                teamStatsById={teamStatsById}
                players={sortedPlayers}
                teamDisplayName={guardianDisplayName}
                recallSummary={classRecallSummary}
                recallLabelFor={(conceptId) => recallQuestionsById.get(conceptId)?.label ?? conceptId}
                evidence={isCompletedRound ? selectedEvidence : null}
                busy={busy}
                onPrint={() => window.print()}
                onExportExcel={() => downloadLearningWorkbook(exportEntries, roomCode)}
                onPrepareNextRound={() => setConfirmAction('prepare')}
                onCloseRoom={() => setConfirmAction('close')}
                closedRoomAction={
                  service.isDemo && roomCode === service.demoRoomCode ? (
                    <button type="button" className="result-room-primary" onClick={() => void openDemoRoom()} disabled={busy}>รีเซ็ตห้องสาธิต {service.demoRoomCode}</button>
                  ) : (
                    <button type="button" className="result-room-primary" onClick={() => { setRoomCode(''); setNotice('') }}>สร้างห้องใหม่</button>
                  )
                }
              />
            ) : null}

            {/* The teamSetup stage renders its own roster and controls above, so the dashboard's
                copy of both would be a duplicate screen below the fold — it is skipped entirely
                for that stage. Every other stage still gets the full dashboard. */}
            {/* Inline style, not the `hidden` attribute: Tailwind's `grid` utility would otherwise
                win over `[hidden] { display: none }` and the block would stay visible. */}
            {/* finalMode joins this list: the result command centre above now carries the team
                board, the per-student view and the room controls, so the dashboard's copy of all
                three would be a duplicate screen below the fold. */}
            <div style={isTeamSetupPhase || isPostTestPhase || isSurveyPhase || finalMode ? { display: 'none' } : undefined} className={`teacher-dashboard mt-6 grid items-start gap-6 ${finalMode ? 'teacher-final-dashboard ' : ''}${broadcastMode ? '' : 'lg:grid-cols-[1.45fr_0.75fr]'}`}>
              <section className={`glass-panel teacher-scoreboard overflow-hidden ${broadcastMode ? 'teacher-scoreboard-live' : ''}`}>
                {/* Item 3: header is centered while playing (LIVE badge sits directly under the
                    title, not pinned top-right) — the close/reveal/advance-now controls used to
                    live in this row's top-right corner; they've moved to .scoreboard-action-row
                    at the bottom of this section, beside หยุดเกม, so this header is just the
                    title + a status indicator, not a control cluster. */}
                <div className={`scoreboard-header ${roomState.data.status === 'playing' ? 'scoreboard-header-centered' : ''}`}>
                  <div>
                    <p className="eyebrow">
                      {roomState.data.status === 'playing' ? 'คะแนนสดแบบเรียลไทม์' : finalMode ? 'สรุปผลภารกิจ' : 'รายชื่อผู้เข้าร่วม'}
                    </p>
                    <h2>{roomState.data.status === 'waiting' ? 'ผู้เล่นและทีม' : 'กระดานคะแนนทุกทีม'}</h2>
                  </div>
                  {roomState.data.status === 'playing' ? (
                    <span className="live-score-pill"><i />LIVE</span>
                  ) : finalMode ? (
                    <div className="broadcast-header-actions" role="tablist" aria-label="มุมมองผลคะแนน">
                      <button type="button" className={resultsTab === 'team' ? 'live-score-pill' : 'copy-button'} onClick={() => setResultsTab('team')} aria-pressed={resultsTab === 'team'}>ทีม</button>
                      <button type="button" className={resultsTab === 'individual' ? 'live-score-pill' : 'copy-button'} onClick={() => setResultsTab('individual')} aria-pressed={resultsTab === 'individual'}>รายบุคคล</button>
                    </div>
                  ) : <span className="count-badge">{sortedPlayers.length} คน</span>}
                </div>
                {roomState.data.status === 'playing' && isBossPhase ? (
                  // Dedicated boss board. Replaces the generic three-stat strip for this phase
                  // only; the main-phase strip below is untouched. Correctness stays hidden
                  // until the answer window closes — the same rule the old strip enforced.
                  <BossBoard
                    room={roomState.data}
                    players={sortedPlayers}
                    teams={roomState.data.teams}
                    teamDisplayName={guardianDisplayName}
                    teamTone={(teamId) => teamToneById.get(teamId) ?? 0}
                    remainingMs={bossRemainingMs}
                    revealRemainingMs={bossRevealRemainingMs}
                    formatCountdown={formatCountdown}
                  />
                ) : roomState.data.status === 'playing' ? (
                  <dl className="broadcast-stats" aria-label="สถานการณ์ปัจจุบันของห้อง">
                    <div><dt>คำถามปัจจุบัน</dt><dd>{roomState.data.currentQuestionIndex + 1}<span>/10</span></dd></div>
                    <div><dt>{revealRemainingMs > 0 ? 'ดูเฉลยอีก' : 'เวลาคงเหลือ'}</dt><dd>{revealRemainingMs > 0 ? formatCountdown(revealRemainingMs) : formatCountdown(remainingMs)}</dd></div>
                    <div><dt>ตอบแล้วข้อนี้</dt><dd>{currentQuestionStats.answeredCount}<span>/{sortedPlayers.length}</span></dd></div>
                    {/* Correct count for the CURRENT question appears only once answers are
                        locked and the reveal has begun — while the timer runs, the teacher sees
                        response progress only. */}
                    <div>
                      <dt>ถูกข้อนี้</dt>
                      <dd>
                        {currentQuestionRevealed
                          ? <>{currentQuestionStats.correctCount}<span>/{sortedPlayers.length}</span></>
                          : <span className="teacher-hidden-until-reveal">รอเฉลย</span>}
                      </dd>
                    </div>
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
                              ? displayTeamNameById.get(player.teamId ?? '') ?? 'ยังไม่ได้จัดทีม'
                              : player.teamId
                                ? `${displayTeamNameById.get(player.teamId) ?? ''} (ยังไม่ล็อก)`
                                : 'ยังไม่ได้จัดทีม'}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )
                ) : showIndividualResults ? (
                  <IndividualResultsTable players={sortedPlayers} questionIds={roomState.data.questionIds} teamNameById={displayTeamNameById} />
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
                            {/* Item strip sits inline right after the team name so the teacher
                                reads "who they are + what they hold" as one unit. Playing-only:
                                items are irrelevant during team setup (nothing can be used yet)
                                and on the result screen (the round is over). Reads the existing
                                inventory/queuedEffect and the same incoming-seal data the badges
                                below already use — no new magic state. */}
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <strong>{guardianDisplayName(team.id)}</strong>
                              {guardianNameById.get(team.id) ? <small className="text-[#8b8377]">{team.name}</small> : null}
                              {roomState.data?.status === 'playing' ? (() => {
                                const magic = magicByTeamId.get(team.id)
                                const incomingSeal = incomingSealCountByTeam.get(team.id)
                                // "กำลังได้รับผล" means the opponent's effect is landing on the
                                // question in play right now, not merely queued for the next one.
                                const incomingIsActive = incomingSeal
                                  && getMagicEffectPhase(incomingSeal.questionIndex, roomState.data?.currentQuestionIndex ?? 0) === 'active'
                                return (
                                  <TeamItemStatus
                                    inventory={magic?.inventory}
                                    activeItemType={magic?.queuedEffect?.itemType ?? null}
                                    incomingEffect={incomingIsActive ? { itemType: 'score_seal', count: incomingSeal.count } : null}
                                  />
                                )
                              })() : null}
                            </span>
                            <small>
                              {team.memberCount} คน
                              {roomState.data?.status === 'playing' ? ` · ตอบแล้ว ${currentQuestionCount}/${team.memberCount}` : ''}
                              {' · เล่นจบ '}{fullGame?.submittedCount ?? 0}/{team.memberCount}
                              {' · ถูก '}{fullGame?.correctCount ?? 0} ข้อ
                            </small>
                            <div className="scoreboard-progress" aria-label={`เล่นจบแล้ว ${fullGame?.submittedCount ?? 0} จาก ${team.memberCount} คน`}><i style={{ width: `${team.memberCount > 0 ? ((fullGame?.submittedCount ?? 0) / team.memberCount) * 100 : 0}%` }} /></div>
                            {/* Item 1 (follow-up): current magic status lives directly on the
                                scoreboard row now — the teacher reads every team's active/queued
                                effect here without scrolling to the (now history-only) section
                                below. Playing-only: queuedEffect/incoming seals only ever exist
                                once the room is 'playing'. */}
                            {roomState.data?.status === 'playing' ? (() => {
                              const magic = magicByTeamId.get(team.id)
                              const incomingSeal = incomingSealCountByTeam.get(team.id)
                              const hasShield = (magic?.inventory.rose_shield.available ?? 0) > 0
                              const currentQuestionIndex = roomState.data?.currentQuestionIndex ?? 0
                              if (!magic?.queuedEffect && !incomingSeal && !hasShield) return null
                              return (
                                <div className="magic-status-badges" role="list" aria-label="สถานะมนตราปัจจุบัน">
                                  {magic?.queuedEffect ? (() => {
                                    const phaseLabel = getMagicEffectPhase(magic.queuedEffect.affectedQuestionIndex, currentQuestionIndex) === 'active' ? 'กำลังมีผลในข้อนี้' : 'ข้อต่อไป'
                                    const itemLabel = magic.queuedEffect.itemType === 'power_surge' ? 'x2' : magic.queuedEffect.itemType === 'illusion' ? 'มายา' : `ผนึก ${displayTeamNameById.get(magic.queuedEffect.targetTeamId) ?? '-'}`
                                    return (
                                      <span className={`magic-badge magic-badge-${magic.queuedEffect.itemType === 'power_surge' ? 'surge' : magic.queuedEffect.itemType === 'illusion' ? 'illusion' : 'seal'}`} role="listitem">
                                        <MagicItemIcon itemType={magic.queuedEffect.itemType} size="sm" />
                                        {itemLabel} {phaseLabel}
                                      </span>
                                    )
                                  })() : null}
                                  {incomingSeal ? (
                                    <span className="magic-badge magic-badge-seal" role="listitem">
                                      <MagicItemIcon itemType="score_seal" size="sm" /> เหลือ {formatHostilePercent(computeHostileMultiplier(incomingSeal.count))}% {getMagicEffectPhase(incomingSeal.questionIndex, currentQuestionIndex) === 'active' ? 'กำลังมีผลในข้อนี้' : 'ข้อต่อไป'}
                                    </span>
                                  ) : null}
                                  {hasShield ? (
                                    <span className="magic-badge magic-badge-shield" role="listitem">
                                      <MagicItemIcon itemType="rose_shield" size="sm" /> ป้องกันอัตโนมัติได้อีก {magic?.inventory.rose_shield.available} ครั้ง
                                    </span>
                                  ) : null}
                                </div>
                              )
                            })() : null}
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
                {/* Item 3: bottom action row — close/reveal-now and advance-now moved out of the
                    header, alongside หยุดเกม (kept visually destructive via
                    .emergency-stop-button). Only rendered while playing, since the controls
                    aside below (which used to hold the room-level "ยุติห้อง") is hidden during
                    broadcastMode — this is the only destructive control visible mid-game. */}
                {roomState.data.status === 'playing' ? (
                  <div className="scoreboard-action-row">
                    {canCloseQuestionEarly ? (
                      <button className="secondary-button" type="button" onClick={handleCloseQuestionEarly}>ปิดรับคำตอบและเฉลยทันที</button>
                    ) : null}
                    {canAdvanceNow ? (
                      <button className="secondary-button" type="button" onClick={handleAdvanceNow}>ไปข้อถัดไปทันที</button>
                    ) : null}
                    <button className="emergency-stop-button emergency-stop-button-inline" type="button" onClick={() => setConfirmAction('stop')} disabled={busy}>หยุดเกม</button>
                  </div>
                ) : null}
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
                    {/* During teamSetup these same controls live on the dedicated stage screen
                        above, so the dashboard does not render a second copy of them. */}
                    {roomState.data.status === 'waiting' && !isTeamSetupPhase ? (
                      <>
                        <div className="timer-setting">
                          <label htmlFor="team-count-dashboard">จำนวนทีม</label>
                          <NumberStepper
                            id="team-count-dashboard"
                            label="จำนวนทีม"
                            value={teamCountValue}
                            onChange={setTeamCountValue}
                            min={1}
                            max={20}
                            disabled={roomState.data.teamsLocked}
                          />
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
                        {/* Boss timing sits beside the Main timing control, since both are set in
                            the same "before Main starts" moment. One value applies to all 3 boss
                            questions; boss scoring/ranking/first-answer-lock are untouched. */}
                        <div className="timer-setting">
                          <label htmlFor="boss-duration">เวลาต่อข้อ (ด่านชิงมนตรา)</label>
                          <div>
                            <input
                              id="boss-duration"
                              type="number"
                              min={MIN_BOSS_SECONDS_PER_QUESTION}
                              max={MAX_BOSS_SECONDS_PER_QUESTION}
                              step="1"
                              value={bossDurationValue}
                              onChange={(event) => setBossDurationValue(event.target.value)}
                            />
                            <span className="timer-setting-unit">วินาที</span>
                          </div>
                          <small>{MIN_BOSS_SECONDS_PER_QUESTION}-{MAX_BOSS_SECONDS_PER_QUESTION} วินาที · ใช้กับทั้ง 3 ข้อของด่านชิงมนตรา</small>
                        </div>
                        <button
                          className="primary-button w-full"
                          onClick={requestStart}
                          disabled={busy || sortedPlayers.length === 0 || !durationValid || !bossDurationValid || !roomState.data.teamsLocked || teamsWithoutCaptain.length > 0 || teamsWithoutName.length > 0 || teamsWithoutStartingItem.length > 0}
                        >
                          {roomState.data.currentRound === 1 ? 'เริ่มภารกิจพร้อมจับเวลา' : 'เริ่มรอบใหม่พร้อมจับเวลา'}
                        </button>
                        {!roomState.data.teamsLocked ? (
                          <p className="text-sm text-[#bdb5ac]">ต้องล็อกทีมก่อนจึงจะเริ่มภารกิจได้</p>
                        ) : teamsWithoutCaptain.length > 0 ? (
                          <p className="text-sm text-[#bdb5ac]">ยังมี {teamsWithoutCaptain.length} ทีมที่ยังไม่ได้เลือกหัวหน้าทีม กรุณาให้สมาชิกโหวตหรือสรุปผลก่อนเริ่มภารกิจ</p>
                        ) : teamsWithoutName.length > 0 ? (
                          <p className="text-sm text-[#bdb5ac]">ยังมี {teamsWithoutName.length} ทีมที่ยังไม่ได้ตั้งชื่อทีม กรุณาให้หัวหน้าทีมตั้งชื่อก่อนเริ่มภารกิจ</p>
                        ) : teamsWithoutStartingItem.length > 0 ? (
                          <p className="text-sm text-[#bdb5ac]">ยังมี {teamsWithoutStartingItem.length} ทีมที่ยังไม่ได้เลือกไอเทมเริ่มต้น กรุณาให้หัวหน้าทีมเลือกไอเทมก่อนเริ่มภารกิจ</p>
                        ) : null}
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

            {/* Grimoire access point — always visible once teams exist, regardless of round
                status or whether any magic event has happened yet (unlike the history log
                below, which only renders once there's something to show), since it's a pure
                reference the teacher may want to consult before a single item is ever used. */}
            {/* On the teamSetup stage this trigger lives inside the settings panel instead, so no
                lone button floats between sections. */}
            {roomState.data.teams.length > 0 && !isTeamSetupPhase && !finalMode ? (
              <div className="mt-6 flex justify-end">
                <button type="button" className="grimoire-trigger-button" onClick={() => setGrimoireOpen(true)}>
                  📜 คัมภีร์มนตรา
                </button>
              </div>
            ) : null}

            {/* Item 2 (follow-up): the big per-team status cards (score stats, inventory,
                active-status badges) used to duplicate what the main scoreboard now shows
                directly on each team row (item 1) — removed here. What's left: the waiting-only
                team setup controls (captain election + guardian name, which have no scoreboard
                equivalent and must stay per item 7), a recent-activity history log, and a small
                icon legend. Information hierarchy is now: scoreboard = current state, this
                section = setup controls (waiting) + history (always). */}
            {/* On the teamSetup stage this panel is rendered inside the settings column instead,
                so the whole stage stays within one viewport. */}
            {roomState.data.teams.length > 0 && roomState.data.status === 'waiting' && !isTeamSetupPhase ? (
              <section className="glass-panel mt-6 p-5" aria-label="ตั้งค่าทีม">
                <p className="eyebrow">ตั้งค่าทีม</p>
                <h2 className="mt-1 text-xl font-semibold text-[#fff7df]">หัวหน้าทีมและชื่อทีม</h2>
                <ul className="mt-4 space-y-3">{teamAdminRows}
                </ul>
              </section>
            ) : null}

            {/* Learning history: every round already recorded for this room, newest data kept
                immutable by the service layer. Collapsed by default so it never competes with the
                live dashboard, and available even after the room is closed. */}
            {roundHistoryState.data.length > 0 && !finalMode ? (
              <section className="glass-panel mt-6 p-5" aria-label="ประวัติผลการเรียน">
                <div className="learning-history-heading">
                  <div>
                    <p className="eyebrow">ประวัติผลการเรียน</p>
                    <h2 className="mt-1 text-xl font-semibold text-[#fff7df]">
                      {historyRounds.length} รอบ · {roundHistoryState.data.length} รายการ
                    </h2>
                  </div>
                  <div className="learning-history-actions">
                    <button type="button" className="copy-button" onClick={() => setHistoryOpen((open) => !open)}>
                      {historyOpen ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียด'}
                    </button>
                    <button type="button" className="copy-button" onClick={() => downloadLearningWorkbook(exportEntries, roomCode)}>
                      ⬇ ดาวน์โหลด Excel
                    </button>
                  </div>
                </div>
                {/* Round picker. Selecting a past round shows its DURABLE evidence below and is
                    what the print action uses, so a reset round stays fully inspectable. */}
                {availableRounds.length > 0 ? (
                  <div className="evidence-round-picker">
                    <span>เลือกรอบ</span>
                    {availableRounds.map((round) => (
                      <button
                        key={round}
                        type="button"
                        className={`copy-button ${round === activeRound ? 'is-selected' : ''}`}
                        onClick={() => setSelectedRound(round)}
                      >
                        รอบที่ {round}
                      </button>
                    ))}
                  </div>
                ) : null}

                {activeRound !== null && selectedEvidence ? (
                  <EvidenceSummaryPanel
                    summary={selectedEvidence}
                    title={`สรุปหลักฐานการเรียนรู้ — รอบที่ ${activeRound}`}
                    sourceNote={activeRound === roomState.data?.currentRound ? 'รอบปัจจุบัน' : 'จากประวัติที่บันทึกไว้'}
                  />
                ) : null}

                {historyOpen ? (
                  <div className="learning-history-scroll mt-4">
                    <table className="learning-history-table">
                      <thead>
                        <tr>
                          <th>ชื่อ</th>
                          <th>เลขที่</th>
                          <th>รอบ</th>
                          <th>ทีม</th>
                          <th>ผลการทบทวน</th>
                          <th>ผลการเล่นเกมหลัก</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roundHistoryState.data.map((entry) => (
                          <tr key={entry.id}>
                            <td className="text-[#fff7df]">{entry.displayName}</td>
                            <td>{entry.studentNumber}</td>
                            <td>{entry.round}</td>
                            <td>{entry.teamName || '-'}</td>
                            {/* Two standalone results. Rounds recorded before the standalone
                                recall figure existed fall back to the legacy read-only count so
                                old history still shows something, never a crash. */}
                            <td>{entry.recallCorrectCount ?? entry.beforeCorrectCount ?? 0}/{entry.recallTotalCount ?? RECALL_QUESTION_COUNT}</td>
                            <td>{entry.knowledgeScore100}/100</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </section>
            ) : null}

            {magicEventsState.data.length > 0 && !finalMode ? (
              <section className="glass-panel mt-6 p-5" aria-label="ประวัติมนตรา">
                <p className="eyebrow">ประวัติ</p>
                <h2 className="mt-1 text-xl font-semibold text-[#fff7df]">กิจกรรมมนตราล่าสุด</h2>
                {/* Small, genuinely-useful legend — the scoreboard badges above are icon-first,
                    so a one-time reference for what each icon means earns its place here rather
                    than repeating per-team (which would just recreate the removed cards). */}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#8b8377]">
                  {MAGIC_ITEM_TYPES.map((itemType) => (
                    <span key={itemType} className="inline-flex items-center gap-1">
                      <MagicItemIcon itemType={itemType} size="sm" /> {MAGIC_ITEM_INFO[itemType].label}
                    </span>
                  ))}
                </div>
                <ul className="mt-3 space-y-1 border-t border-white/10 pt-3 text-xs text-[#c0b7ab]">
                  {magicEventsState.data.slice(0, 8).map((event) => {
                    const statusLabel = {
                      queued: 'รอผล',
                      applied: 'สำเร็จ',
                      blocked: 'ถูกบล็อก',
                      expired: 'หมดอายุ',
                      rejected: 'ถูกปฏิเสธ',
                    }[event.status]
                    return (
                      <li key={event.id} className="flex items-center gap-1.5">
                        <MagicItemIcon itemType={event.itemType} size="sm" />
                        {displayTeamNameById.get(event.sourceTeamId) ?? event.sourceTeamId} ใช้ {MAGIC_ITEM_INFO[event.itemType].label}
                        {event.targetTeamId && event.targetTeamId !== event.sourceTeamId ? ` → ${displayTeamNameById.get(event.targetTeamId) ?? event.targetTeamId}` : ''}
                        {event.affectedQuestionIndex != null ? ` (ข้อ ${event.affectedQuestionIndex + 1})` : ''}
                        {' — '}{statusLabel}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}
              </>
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


      {/* Print-only report for the finished round. Hidden on screen; the "ดาวน์โหลด PDF" button
          calls window.print() and the browser's own "Save as PDF" produces the file. */}
      {roomState.data ? (
        <TeacherReportPrintView
          roomCode={roomCode}
          round={printRound}
          players={visibleSortedPlayers}
          questionIds={roomState.data.questionIds}
          teamNameById={displayTeamNameById}
          evidence={printEvidence}
          strongestConceptLabel={classRecallSummary.strongestConceptId ? recallQuestionsById.get(classRecallSummary.strongestConceptId)?.label ?? '-' : '-'}
          weakestConceptLabel={classRecallSummary.weakestConceptId ? recallQuestionsById.get(classRecallSummary.weakestConceptId)?.label ?? '-' : '-'}
        />
      ) : null}

      {/* Persistent BGM control — rendered outside the stage-specific content so it stays put
          through every phase, including the screens where the room-control header is hidden. */}
      <BackgroundMusicControls controls={backgroundMusic} />

      <GrimoireModal open={grimoireOpen} onClose={() => setGrimoireOpen(false)} />

      {/* Item 7: teacher-side dramatic spell-event overlay — one event at a time, 5.5s, same
          copy/tone the student toast uses (buildTeacherSpellEventCopy), but centered/prominent
          per "teacher-side major event popup can be more prominent". */}
      {activeSpellEvent ? (
        <div className="spell-event-backdrop" aria-live="assertive">
          <div className={`spell-event-overlay spell-event-${activeSpellEvent.tone}`}>
            <span className="spell-event-icon-wrap" aria-hidden="true">
              <span className="spell-event-glow" />
              <MagicItemIcon
                itemType={activeSpellEvent.tone === 'surge' ? 'power_surge' : activeSpellEvent.tone === 'seal' ? 'score_seal' : activeSpellEvent.tone === 'illusion' ? 'illusion' : 'rose_shield'}
                size="lg"
              />
            </span>
            <strong className="spell-event-headline">{activeSpellEvent.headline}</strong>
            <p className="spell-event-body">{activeSpellEvent.body}</p>
          </div>
        </div>
      ) : null}
    </ScenePage>
  )
}
