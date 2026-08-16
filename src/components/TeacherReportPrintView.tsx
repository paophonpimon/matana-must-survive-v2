import { createPortal } from 'react-dom'
import type { Player } from '../types/game'

interface TeacherReportPrintViewProps {
  roomCode: string
  round: number
  players: Player[]
  questionIds: string[]
  teamNameById: Map<string, string>
  beforeAverage: number
  afterAverage: number
  strongestConceptLabel: string
  weakestConceptLabel: string
}

// Print-only report for the finished round, rendered into the normal document and revealed by the
// `@media print` rules in styles.css. The teacher's browser then produces the PDF via its own
// "Save as PDF" destination.
//
// Why the browser's print pipeline rather than generating PDF bytes in JS: Thai is a complex
// script — vowels and tone marks stack above and below the base consonant and need real glyph
// positioning. A hand-rolled PDF writer would have to embed and subset a Thai font AND reproduce
// that shaping, which is exactly how "broken Thai glyphs" happens. Handing the layout to the
// browser's text engine makes correct Thai the default rather than something to get right.
//
// The table deliberately mirrors the on-screen "รายบุคคล" results table — same columns, same
// order, same ✓ / ✕ / – symbols — so the printout reads as the same artefact the teacher was
// just looking at, not a separate report format.
export const TeacherReportPrintView = ({
  roomCode,
  round,
  players,
  questionIds,
  teamNameById,
  beforeAverage,
  afterAverage,
  strongestConceptLabel,
  weakestConceptLabel,
}: TeacherReportPrintViewProps) => {
  const printedAt = new Date().toLocaleString('th-TH', {
    dateStyle: 'long',
    timeStyle: 'short',
  })

  // Portalled to <body> rather than left inside the app tree. That is what lets the print rules
  // switch the entire app off with `display: none` (which removes it from layout) instead of
  // `visibility: hidden` (which leaves full-height boxes behind and generates blank pages) —
  // the report is a sibling of #root, not a descendant, so hiding #root cannot hide the report.
  return createPortal(
    <div className="print-report" role="document" aria-hidden="true">
      <header className="print-report-header">
        <h1>มัทนาต้องรอด</h1>
        <p className="print-report-subtitle">สรุปผลการเรียนรู้ — รอบที่ {round}</p>
        <p className="print-report-meta">
          ห้อง {roomCode} · วันที่ {printedAt} · จำนวนผู้เรียน {players.length} คน
        </p>
      </header>

      {/* Compact learning summary above the table, matching the teacher's on-screen wording. */}
      <dl className="print-report-summary">
        <div><dt>ก่อนเล่นเฉลี่ย</dt><dd>{beforeAverage.toFixed(1)}/5</dd></div>
        <div><dt>หลังเล่นเฉลี่ย</dt><dd>{afterAverage.toFixed(1)}/5</dd></div>
        <div><dt>เรื่องที่เข้าใจดีที่สุด</dt><dd>{strongestConceptLabel}</dd></div>
        <div><dt>เรื่องที่ควรทบทวน</dt><dd>{weakestConceptLabel}</dd></div>
      </dl>

      <table className="print-report-table">
        <thead>
          <tr>
            <th className="print-col-name">ชื่อผู้เล่น</th>
            <th>เลขที่</th>
            <th className="print-col-team">ทีม</th>
            {questionIds.map((_, index) => <th key={index} className="print-col-q">ข้อ {index + 1}</th>)}
            <th>คะแนนความรู้</th>
            <th>ไม่ได้ตอบ</th>
          </tr>
        </thead>
        <tbody>
          {players.map((player) => {
            const unansweredCount = questionIds.filter((questionId) => !player.answers.some((answer) => answer.questionId === questionId)).length
            return (
              <tr key={player.id}>
                <td className="print-col-name">{player.displayName}</td>
                <td>{player.studentNumber}</td>
                <td className="print-col-team">{teamNameById.get(player.teamId ?? '') ?? '-'}</td>
                {questionIds.map((questionId) => {
                  const answer = player.answers.find((item) => item.questionId === questionId)
                  // Same three-state symbol set the on-screen table uses.
                  const symbol = !answer ? '–' : answer.isCorrect ? '✓' : '✕'
                  const className = !answer ? 'print-mark-missing' : answer.isCorrect ? 'print-mark-correct' : 'print-mark-wrong'
                  return <td key={questionId} className={`print-col-q ${className}`}>{symbol}</td>
                })}
                <td className="print-col-score">{player.score * 10}/100</td>
                <td>{unansweredCount}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {players.length === 0 ? <p className="print-report-empty">ยังไม่มีข้อมูลผู้เรียนในรอบนี้</p> : null}
      <p className="print-report-footnote">
        คะแนนความรู้คิดจากคำถามหลัก {questionIds.length} ข้อ · ✓ ตอบถูก · ✕ ตอบผิด · – ไม่ได้ตอบ
      </p>
    </div>,
    document.body,
  )
}
