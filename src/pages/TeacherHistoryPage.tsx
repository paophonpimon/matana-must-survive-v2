import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandHeader, LoadingPanel, ScenePage } from '../components/Layout'
import { EvidenceSummaryPanel } from '../components/EvidenceSummaryPanel'
import { TeacherReportPrintView } from '../components/TeacherReportPrintView'
import { TeacherResultCommandCenter } from '../components/TeacherResultCommandCenter'
import { useGame } from '../context/GameContext'
import { computeEvidenceSummaryFromHistory } from '../lib/evidenceSummary'
import { parseRosterCsv } from '../lib/rosterCsv'
import { SHOWCASE_ROOM_CODE } from '../lib/showcaseRound'
import { computeClassRecallSummary } from '../lib/learning'
import { computeTeamCompetitionStats } from '../lib/magic'
import { computeTeamStats } from '../lib/teamScoring'
import { recallQuestionsById } from '../data/recallQuestions'
import { downloadLearningWorkbook } from '../lib/learningExport'
import {
  distinctStudentCount,
  entriesForRound,
  historyToDerivedPlayers,
  historyToPrintablePlayers,
  questionIdsFromHistory,
  summarizeRoundHistory,
  teamNamesFromHistory,
  teamsFromHistory,
} from '../lib/roomHistory'
import { friendlyError } from '../services/gameService'
import type { Player, RoundHistoryEntry, TeacherRoomSummary } from '../types/game'

const STATUS_LABELS: Record<TeacherRoomSummary['status'], string> = {
  waiting: 'ห้องรอ',
  playing: 'กำลังเล่น',
  completed: 'จบรอบแล้ว',
  closed: 'ปิดห้องแล้ว',
}

// A room recorded before completedAt existed reports 0 — shown as '-', never as the epoch.
const formatDateTime = (value: number): string =>
  value > 0 ? new Date(value).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '-'

// Read-only teacher archive. Every figure here comes from RoundHistory through
// computeEvidenceSummaryFromHistory — the same aggregation the live panel, the printout and the
// workbook already use — so a historical round can never disagree with how it looked when it ended.
//
// Nothing on this page can resume or mutate a room: the only service calls are listTeacherRooms
// and subscribeRoundHistory, both read-only, and no gameplay transition is reachable from here.
export const TeacherHistoryPage = () => {
  // uid is the authoritative Firebase identity, same as TeacherPage uses. Room ownership is
  // teacherSessionId === uid, so this is what scopes the whole screen.
  const { service, uid } = useGame()

  const [rooms, setRooms] = useState<TeacherRoomSummary[]>([])
  const [roomsLoading, setRoomsLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedRoomCode, setSelectedRoomCode] = useState('')
  const [entries, setEntries] = useState<RoundHistoryEntry[]>([])
  const [entriesLoading, setEntriesLoading] = useState(false)
  const [selectedRound, setSelectedRound] = useState<number | null>(null)
  const [printing, setPrinting] = useState(false)
  // Opens the polished Result command centre over the SELECTED stored round, read-only.
  const [resultViewOpen, setResultViewOpen] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importNotice, setImportNotice] = useState('')

  useEffect(() => {
    if (!uid) return
    let cancelled = false
    setRoomsLoading(true)
    service.listTeacherRooms(uid)
      .then((result) => { if (!cancelled) setRooms(result) })
      .catch((reason: unknown) => { if (!cancelled) setError(friendlyError(reason)) })
      .finally(() => { if (!cancelled) setRoomsLoading(false) })
    return () => { cancelled = true }
  }, [service, uid])

  // One subscription for the room being inspected. Reusing the existing round-history
  // subscription rather than adding a one-shot fetch keeps history reads on a single code path.
  useEffect(() => {
    if (!selectedRoomCode) { setEntries([]); return }
    setEntriesLoading(true)
    const stop = service.subscribeRoundHistory(
      selectedRoomCode,
      (value) => { setEntries(value); setEntriesLoading(false) },
      (message) => { setError(message); setEntriesLoading(false) },
    )
    return () => stop()
  }, [selectedRoomCode, service])

  const rounds = useMemo(() => summarizeRoundHistory(entries), [entries])
  // Distinct students across the whole opened room, derived from the history already in hand.
  const roomStudentCount = useMemo(() => distinctStudentCount(entries), [entries])

  // Default to the newest recorded round whenever the current selection stops being valid.
  useEffect(() => {
    if (rounds.length === 0) { setSelectedRound(null); return }
    if (selectedRound == null || !rounds.some((entry) => entry.round === selectedRound)) {
      setSelectedRound(rounds[0].round)
    }
  }, [rounds, selectedRound])

  const roundEntries = useMemo(
    () => (selectedRound == null ? [] : entriesForRound(entries, selectedRound)),
    [entries, selectedRound],
  )
  const evidence = useMemo(() => computeEvidenceSummaryFromHistory(roundEntries), [roundEntries])
  const printPlayers = useMemo(() => historyToPrintablePlayers(roundEntries), [roundEntries])
  const printQuestionIds = useMemo(() => questionIdsFromHistory(roundEntries), [roundEntries])
  const printTeamNames = useMemo(() => teamNamesFromHistory(roundEntries), [roundEntries])

  // ── Result command centre reconstruction, from the snapshot alone ────────────────────────────
  // Every figure below comes from an EXISTING aggregator fed player-shaped rows rebuilt from the
  // recorded round. No formula is re-implemented here, and no live player document is needed.
  const derivedPlayers = useMemo(() => historyToDerivedPlayers(roundEntries), [roundEntries])
  const historyTeams = useMemo(() => teamsFromHistory(roundEntries), [roundEntries])
  const historyTeamStats = useMemo(
    () => computeTeamStats(derivedPlayers as unknown as Player[], historyTeams),
    [derivedPlayers, historyTeams],
  )
  const historyTeamStatsById = useMemo(
    () => new Map(historyTeamStats.map((team) => [team.id, team])),
    [historyTeamStats],
  )
  // No magic events are recorded in history, so the competition score equals the raw team score —
  // which is correct for a replay: an item effect that was applied live is already baked into the
  // per-question correctness the snapshot holds.
  const historyCompetitionStats = useMemo(
    () => computeTeamCompetitionStats(derivedPlayers as unknown as Player[], historyTeams, printQuestionIds, [], selectedRound ?? 1),
    [derivedPlayers, historyTeams, printQuestionIds, selectedRound],
  )
  const historyRecallSummary = useMemo(
    () => computeClassRecallSummary(derivedPlayers as unknown as Player[]),
    [derivedPlayers],
  )

  // Mounts the print view for THIS room and THIS round, then prints. The active-room report lives
  // on a different page entirely, so it cannot be printed from here by accident.
  const handlePrint = useCallback(() => {
    if (roundEntries.length === 0) return
    setPrinting(true)
    window.setTimeout(() => {
      window.print()
      setPrinting(false)
    }, 60)
  }, [roundEntries])

  const openRoom = (roomCode: string): void => {
    setError('')
    setSelectedRound(null)
    setSelectedRoomCode(roomCode)
  }

  // Showcase import. Runs entirely on the teacher's existing authenticated session: ownership is
  // taken from `uid`, never entered by hand. The roster is read from a file the teacher picks
  // here and is never stored in this application.
  const handleImportShowcase = async (file: File): Promise<void> => {
    if (!uid) return
    setImportBusy(true)
    setImportNotice('')
    setError('')
    try {
      const roster = parseRosterCsv(await file.text(), 'ม.5/1')
      await service.importShowcaseRound(SHOWCASE_ROOM_CODE, uid, roster)
      setImportNotice(`นำเข้าห้องสาธิต ${SHOWCASE_ROOM_CODE} เรียบร้อย (ข้อมูลผลลัพธ์เป็นข้อมูลจำลองสำหรับนำเสนอ)`)
      const summaries = await service.listTeacherRooms(uid)
      setRooms(summaries)
    } catch (reason) {
      setError(friendlyError(reason))
    } finally {
      setImportBusy(false)
    }
  }

  if (!uid) {
    return (
      <ScenePage image="/images/lobby.png">
        <BrandHeader />
        <div className="mx-auto flex w-full max-w-3xl flex-1 items-center px-5 py-12">
          <LoadingPanel />
        </div>
      </ScenePage>
    )
  }

  // Full-screen read-only Result command centre over the selected stored round. Rendered instead
  // of the list (not on top of it) so the existing History page keeps its own layout untouched.
  if (resultViewOpen && selectedRound != null && roundEntries.length > 0) {
    return (
      <ScenePage compact className="teacher-final-page">
        <BrandHeader />
        <div className="teacher-shell mx-auto w-full max-w-7xl flex-1 px-5 pt-4 sm:px-8">
          <TeacherResultCommandCenter
            round={selectedRound}
            roomStatus="completed"
            competitionStats={historyCompetitionStats}
            teamStatsById={historyTeamStatsById}
            players={derivedPlayers as unknown as Player[]}
            teamDisplayName={(teamId) => printTeamNames.get(teamId) ?? teamId}
            recallSummary={historyRecallSummary}
            recallLabelFor={(conceptId) => recallQuestionsById.get(conceptId)?.label ?? conceptId}
            evidence={evidence}
            busy={false}
            onPrint={handlePrint}
            onExportExcel={() => downloadLearningWorkbook(roundEntries, `${selectedRoomCode}-รอบ${selectedRound}`)}
            historical={{ roomCode: selectedRoomCode, onBack: () => setResultViewOpen(false) }}
          />
        </div>
        {printing ? (
          <TeacherReportPrintView
            roomCode={selectedRoomCode}
            round={selectedRound}
            players={printPlayers}
            questionIds={printQuestionIds}
            teamNameById={printTeamNames}
            evidence={evidence}
            strongestConceptLabel={historyRecallSummary.strongestConceptId ? recallQuestionsById.get(historyRecallSummary.strongestConceptId)?.label ?? '-' : '-'}
            weakestConceptLabel={historyRecallSummary.weakestConceptId ? recallQuestionsById.get(historyRecallSummary.weakestConceptId)?.label ?? '-' : '-'}
          />
        ) : null}
      </ScenePage>
    )
  }

  return (
    <ScenePage image="/images/lobby.png">
      <BrandHeader />
      <div className="teacher-shell mx-auto w-full max-w-7xl flex-1 px-5 pb-10 pt-4 sm:px-8">
        <section className="teacher-room-bar">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#b6ab9e]">ประวัติห้อง</p>
            <strong className="room-code">{selectedRoomCode || 'เลือกห้อง'}</strong>
          </div>
          <div className="flex flex-wrap gap-3">
            {selectedRoomCode ? (
              <button type="button" className="copy-button" onClick={() => openRoom('')}>กลับไปรายการห้อง</button>
            ) : null}
            <Link className="copy-button" to="/teacher">กลับหน้าครู</Link>
          </div>
        </section>

        {error ? <p className="error-message mt-4" role="alert">{error}</p> : null}
        {importNotice ? <p className="success-message mt-4" role="status">{importNotice}</p> : null}

        {!selectedRoomCode ? (
          <section className="glass-panel mt-4">
            <h2 className="text-lg font-semibold">ห้องของคุณ</h2>
            <p className="mt-1 text-sm text-[#c0b7ab]">แสดงเฉพาะห้องที่บัญชีครูนี้เป็นผู้สร้าง เรียงจากใหม่ไปเก่า</p>
            {/* Showcase import. Ownership comes from the signed-in teacher session automatically —
                no uid is entered. The roster file is read in the browser and never stored here;
                only simulated evidence is generated from it. */}
            <details className="showcase-import mt-4">
              <summary>นำเข้าห้องสาธิตสำหรับนำเสนอ</summary>
              <p className="mt-2 text-sm text-[#c0b7ab]">
                สร้างห้อง <strong>{SHOWCASE_ROOM_CODE}</strong> จากไฟล์รายชื่อในเครื่องของคุณ
                ผลการเรียนทั้งหมดเป็น<strong>ข้อมูลจำลองสำหรับนำเสนอ</strong> ไม่ใช่ผลการวัดจริง
                ระบบจะไม่เขียนทับห้องเรียนปกติ
              </p>
              <label className="showcase-import-file mt-2">
                <span>{importBusy ? 'กำลังนำเข้า...' : 'เลือกไฟล์รายชื่อ (.csv)'}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={importBusy}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) void handleImportShowcase(file)
                  }}
                />
              </label>
            </details>
            {roomsLoading ? <LoadingPanel text="กำลังโหลดรายการห้อง..." /> : rooms.length === 0 ? (
              <p className="mt-4 text-sm text-[#8b8377]">ยังไม่มีห้องที่บันทึกไว้</p>
            ) : (
              <ul className="mt-4 grid gap-2">
                {rooms.map((room) => (
                  <li key={room.roomCode}>
                    {/* Room-document fields only. Round and student counts deliberately do NOT
                        appear here: deriving them would mean reading every room's history just to
                        paint this list. They show once a room is opened, off the one history load
                        that screen already performs. */}
                    <button type="button" className="choice-button w-full text-left" onClick={() => openRoom(room.roomCode)}>
                      <strong>
                        {room.roomCode}
                        <small className="block text-xs font-normal text-[#c0b7ab]">
                          สร้างเมื่อ {formatDateTime(room.createdAt)} · {STATUS_LABELS[room.status]}
                        </small>
                      </strong>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <>
            <section className="glass-panel mt-4">
              <h2 className="text-lg font-semibold">รอบที่บันทึกไว้</h2>
              {/* Round and student totals live here, not on the room list — both come from the
                  single roundHistory load this screen already performs. studentCount is null when
                  a room recorded nothing, shown as '-' rather than 0. */}
              <p className="mt-1 text-sm text-[#c0b7ab]">
                ดูอย่างเดียว ไม่มีการแก้ไขหรือเล่นต่อ · เรียงจากใหม่ไปเก่า
                {rounds.length > 0 ? ` · ${rounds.length} รอบ · นักเรียน ${roomStudentCount ?? '-'} คน` : ''}
              </p>
              {entriesLoading ? <LoadingPanel text="กำลังโหลดประวัติรอบ..." /> : rounds.length === 0 ? (
                <p className="mt-4 text-sm text-[#8b8377]">ห้องนี้ยังไม่มีรอบที่บันทึกไว้</p>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                  {rounds.map((entry) => (
                    <button
                      key={entry.round}
                      type="button"
                      className={`choice-button ${selectedRound === entry.round ? 'choice-selected' : ''}`}
                      onClick={() => setSelectedRound(entry.round)}
                    >
                      <strong>
                        รอบที่ {entry.round}
                        <small className="block text-xs font-normal text-[#c0b7ab]">
                          {entry.studentCount} คน · {formatDateTime(entry.completedAt)}
                        </small>
                      </strong>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {selectedRound != null && roundEntries.length > 0 ? (
              <>
                <section className="glass-panel mt-4">
                  <div className="flex flex-wrap gap-2">
                    {/* Opens the same polished Result command centre the live screen uses, over
                        this stored round. Read-only — see the historical prop. */}
                    <button type="button" className="primary-button" onClick={() => setResultViewOpen(true)}>
                      เปิดมุมมองผลลัพธ์
                    </button>
                    <button type="button" className="primary-button" onClick={handlePrint}>พิมพ์รายงาน / PDF</button>
                    {/* Selected round only. */}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => downloadLearningWorkbook(roundEntries, `${selectedRoomCode}-รอบ${selectedRound}`)}
                    >
                      ส่งออก Excel รอบนี้
                    </button>
                    {/* Every recorded round of this room in one workbook. History ids are
                        `${round}-${playerId}`, so handing over the whole collection cannot
                        duplicate a student's row within a round. */}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => downloadLearningWorkbook(entries, `${selectedRoomCode}-ทุกรอบ`)}
                    >
                      ส่งออก Excel ทุกรอบ
                    </button>
                  </div>
                </section>

                <EvidenceSummaryPanel
                  summary={evidence}
                  title={`หลักฐานการเรียนรู้ — ห้อง ${selectedRoomCode} รอบที่ ${selectedRound}`}
                  sourceNote="ข้อมูลจากประวัติที่บันทึกไว้ (ดูอย่างเดียว)"
                />
              </>
            ) : null}
          </>
        )}
      </div>

      {printing && selectedRound != null ? (
        <TeacherReportPrintView
          roomCode={selectedRoomCode}
          round={selectedRound}
          players={printPlayers}
          questionIds={printQuestionIds}
          teamNameById={printTeamNames}
          evidence={evidence}
          // Concept highlights are a live-round derivation; a stored round carries no such field,
          // so these read '-' rather than being recomputed from data that isn't there.
          strongestConceptLabel="-"
          weakestConceptLabel="-"
        />
      ) : null}
    </ScenePage>
  )
}
