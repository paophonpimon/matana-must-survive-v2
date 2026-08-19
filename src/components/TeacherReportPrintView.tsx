import { createPortal } from 'react-dom'
import { formatAverage, formatCountWithPercent, formatPercent, formatSignedAverage, type EvidenceSummary  } from '../lib/evidenceSummary'
import type { PrintablePlayer } from '../lib/roomHistory'

interface TeacherReportPrintViewProps {
  roomCode: string
  round: number
  // Widened from Player[] to the minimal printable shape so a recorded round can satisfy it
  // from its own immutable snapshot. The live caller passes real Players and is unaffected.
  players: PrintablePlayer[]
  questionIds: string[]
  teamNameById: Map<string, string>
  // Computed by computeEvidenceSummaryFromHistory — the same function the on-screen panel and
  // the spreadsheet use, so the printed numbers cannot disagree with either.
  evidence: EvidenceSummary
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
  evidence,
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

      {/* Evidence summary, matching the teacher's on-screen panel word for word. Descriptive
          only — it reports what the scores were, never that the activity caused them. */}
      <h2 className="print-section-title">ก่อนเรียน / หลังเรียน</h2>
      <p className="print-report-meta">
        เทียบเฉพาะผู้ทำครบทั้งสองชุด {evidence.prePost.comparedCount} / {evidence.totalStudents} คน
      </p>
      {evidence.prePost.comparedCount === 0 ? (
        <p className="print-report-empty">ยังไม่มีนักเรียนที่ทำครบทั้งสองชุด จึงยังเทียบไม่ได้</p>
      ) : (
        <>
          <dl className="print-report-summary">
            <div><dt>ก่อนเรียน (เฉลี่ย)</dt><dd>{formatAverage(evidence.prePost.preAverage, 2)}/{evidence.prePost.totalCount}</dd></div>
            <div><dt>หลังเรียน (เฉลี่ย)</dt><dd>{formatAverage(evidence.prePost.postAverage, 2)}/{evidence.prePost.totalCount}</dd></div>
            <div><dt>ผลต่างเฉลี่ย</dt><dd>{formatSignedAverage(evidence.prePost.averageDifference, 2)}</dd></div>
          </dl>
          <p className="print-report-meta">
            จากผู้เรียนที่มีข้อมูลก่อน–หลังครบ {evidence.prePost.comparedCount} คน
            <br />
            คะแนนหลังเรียนสูงกว่าก่อนเรียน {evidence.prePost.improvedCount}/{evidence.prePost.comparedCount} คน ({formatPercent(evidence.prePost.improvedPercent)})
            {' · '}เท่าเดิม {evidence.prePost.unchangedCount}/{evidence.prePost.comparedCount} คน ({formatPercent(evidence.prePost.unchangedPercent)})
            {' · '}ต่ำกว่า {evidence.prePost.declinedCount}/{evidence.prePost.comparedCount} คน ({formatPercent(evidence.prePost.declinedPercent)})
          </p>
        </>
      )}

      <h2 className="print-section-title">ผลการเล่นเกมหลัก</h2>
      <dl className="print-report-summary">
        <div><dt>คะแนนเฉลี่ย</dt><dd>{formatAverage(evidence.main.averageScore, 2)}/{evidence.main.totalCount}</dd></div>
        <div><dt>ทำกิจกรรมหลักครบ</dt><dd>{formatCountWithPercent(evidence.main.completedCount, evidence.totalStudents)}</dd></div>
      </dl>

      {/* Reported on its own. Never compared with Main or with pre/post. */}
      <h2 className="print-section-title">ผลการทบทวน</h2>
      <dl className="print-report-summary">
        <div><dt>คะแนนเฉลี่ย</dt><dd>{formatAverage(evidence.recall.averageCorrect, 2)}/{evidence.recall.totalCount}</dd></div>
        <div><dt>ทำการทบทวนครบ</dt><dd>{formatCountWithPercent(evidence.recall.completedCount, evidence.totalStudents)}</dd></div>
        <div><dt>ทบทวนได้ดีที่สุด</dt><dd>{strongestConceptLabel}</dd></div>
        <div><dt>ทบทวนได้น้อยที่สุด</dt><dd>{weakestConceptLabel}</dd></div>
      </dl>

      <h2 className="print-section-title">แบบประเมินกิจกรรม</h2>
      <p className="print-report-meta">ทำแบบประเมินครบ {formatCountWithPercent(evidence.survey.completedCount, evidence.totalStudents)}</p>
      {evidence.survey.responseCount === 0 ? (
        <p className="print-report-empty">ยังไม่มีแบบประเมินที่ทำครบทุกข้อ</p>
      ) : (
        <>
          <dl className="print-report-summary">
            <div><dt>ค่าเฉลี่ยรวม</dt><dd>{formatAverage(evidence.survey.overallAverage, 2)}/5</dd></div>
          </dl>
          <table className="print-report-table print-survey-table">
            <thead>
              <tr><th className="print-col-name">ข้อความ</th><th>ค่าเฉลี่ย</th><th>ผู้ตอบ</th></tr>
            </thead>
            <tbody>
              {evidence.survey.items.map((item, index) => (
                <tr key={item.itemId}>
                  <td className="print-col-name">{index + 1}. {item.statement}</td>
                  <td>{item.responseCount === 0 ? '-' : `${item.average.toFixed(2)}/5`}</td>
                  <td>{item.responseCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2 className="print-section-title">รายบุคคล</h2>
      <table className="print-report-table">
        <thead>
          <tr>
            <th className="print-col-name">ชื่อ</th>
            <th>ก่อนเรียน</th>
            <th>หลังเรียน</th>
            <th>ผลต่าง</th>
            <th>เกมหลัก</th>
            <th>ทำเกมครบ</th>
            <th>ประเมินครบ</th>
          </tr>
        </thead>
        <tbody>
          {evidence.students.map((student) => (
            <tr key={student.playerId}>
              <td className="print-col-name">{student.displayName}</td>
              <td>{student.preScore === null ? '-' : `${student.preScore}/10`}</td>
              <td>{student.postScore === null ? '-' : `${student.postScore}/10`}</td>
              <td>{student.difference === null ? '-' : `${student.difference >= 0 ? '+' : ''}${student.difference}`}</td>
              <td>{student.mainScore}/10</td>
              <td>{student.mainCompleted ? 'ครบ' : `${student.mainAnsweredCount}/10`}</td>
              <td>{student.surveyCompleted ? 'ครบ' : `${student.surveyAnsweredCount}/6`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="print-section-title">รายละเอียดคำถามหลัก</h2>

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
