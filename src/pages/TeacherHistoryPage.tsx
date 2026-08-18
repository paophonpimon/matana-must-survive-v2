import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BrandHeader, LoadingPanel, ScenePage } from '../components/Layout'
import { EvidenceSummaryPanel } from '../components/EvidenceSummaryPanel'
import { TeacherReportPrintView } from '../components/TeacherReportPrintView'
import { useGame } from '../context/GameContext'
import { computeEvidenceSummaryFromHistory } from '../lib/evidenceSummary'
import { downloadLearningWorkbook } from '../lib/learningExport'
import {
  distinctStudentCount,
  entriesForRound,
  historyToPrintablePlayers,
  questionIdsFromHistory,
  summarizeRoundHistory,
  teamNamesFromHistory,
} from '../lib/roomHistory'
import { friendlyError } from '../services/gameService'
import type { RoundHistoryEntry, TeacherRoomSummary } from '../types/game'

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

        {!selectedRoomCode ? (
          <section className="glass-panel mt-4">
            <h2 className="text-lg font-semibold">ห้องของคุณ</h2>
            <p className="mt-1 text-sm text-[#c0b7ab]">แสดงเฉพาะห้องที่บัญชีครูนี้เป็นผู้สร้าง เรียงจากใหม่ไปเก่า</p>
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
