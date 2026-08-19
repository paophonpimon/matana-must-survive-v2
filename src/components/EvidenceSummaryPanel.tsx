import { formatAverage, formatCountWithPercent, formatPercent, formatSignedAverage, type EvidenceSummary } from '../lib/evidenceSummary'

interface EvidenceSummaryPanelProps {
  summary: EvidenceSummary
  title: string
  // Set when the figures come from a stored round-history snapshot rather than live players, so
  // the teacher can tell which source they are reading.
  sourceNote?: string
  // Which blocks to render. The Teacher Result command centre splits the same summary across two
  // tabs — class-level blocks in “สรุปหลักฐานการเรียนรู้”, the per-student table in
  // “รายบุคคล” — so both read from ONE EvidenceSummary and no aggregation is duplicated.
  // Defaults to 'all', which is what the history page and the print view already render.
  sections?: 'all' | 'class' | 'students'
  // Drops the heading/……note row when the surrounding tab already titles the panel.
  hideHeading?: boolean
}

// Teacher evidence panel. Rendered for the just-finished round from live players, and for any
// stored round from round-history — identical markup either way, because both are handed the same
// EvidenceSummary shape produced by the same aggregation.
//
// Descriptive only: it reports what the scores were, never that the activity caused them. One
// classroom, no control group, no randomisation — so no causal wording and no inferential test.
export const EvidenceSummaryPanel = ({ summary, title, sourceNote, sections = 'all', hideHeading = false }: EvidenceSummaryPanelProps) => (
  <div className="evidence-summary mt-6">
    {hideHeading ? null : (
      <>
        <h3 className="evidence-summary-title">{title}</h3>
        <p className="evidence-summary-note">
          จำนวนนักเรียนทั้งหมด {summary.totalStudents} คน
          {sourceNote ? ` · ${sourceNote}` : ''}
        </p>
      </>
    )}

    {sections === 'students' ? null : (
      <>
    <div className="evidence-block">
      <p className="evidence-block-title">
        ก่อนเรียน / หลังเรียน
        <span>เทียบเฉพาะผู้ทำครบทั้งสองชุด {summary.prePost.comparedCount} / {summary.totalStudents} คน</span>
      </p>
      {summary.prePost.comparedCount === 0 ? (
        // Absent data reads as unavailable, never as a zero score.
        <p className="evidence-empty">ไม่มีข้อมูลก่อน/หลังเรียนที่ครบทั้งสองชุดในรอบนี้</p>
      ) : (
        <>
          <dl className="evidence-grid">
            <div><dt>ก่อนเรียน (เฉลี่ย)</dt><dd>{formatAverage(summary.prePost.preAverage, 2)}/{summary.prePost.totalCount}</dd></div>
            <div><dt>หลังเรียน (เฉลี่ย)</dt><dd>{formatAverage(summary.prePost.postAverage, 2)}/{summary.prePost.totalCount}</dd></div>
            <div><dt>ผลต่างเฉลี่ย</dt><dd>{formatSignedAverage(summary.prePost.averageDifference, 2)}</dd></div>
          </dl>
          {/* The denominator every average above was taken over — stated next to them so the
              figure can be traced back to a specific set of students, not just read as a number. */}
          <p className="evidence-summary-note">
            จากผู้เรียนที่มีข้อมูลก่อน–หลังครบ {summary.prePost.comparedCount} คน
          </p>
          {/* Count + denominator + percentage. The denominator is comparedCount (the
              paired-complete subset), never the class total — an incomplete student is not
              evidence of "no change". */}
          <ul className="evidence-trace-list">
            <li>
              <span>คะแนนหลังเรียนสูงกว่าก่อนเรียน</span>
              <b>{summary.prePost.improvedCount}/{summary.prePost.comparedCount} คน · {formatPercent(summary.prePost.improvedPercent)}</b>
            </li>
            <li>
              <span>เท่าเดิม</span>
              <b>{summary.prePost.unchangedCount}/{summary.prePost.comparedCount} คน · {formatPercent(summary.prePost.unchangedPercent)}</b>
            </li>
            <li>
              <span>คะแนนหลังเรียนต่ำกว่าก่อนเรียน</span>
              <b>{summary.prePost.declinedCount}/{summary.prePost.comparedCount} คน · {formatPercent(summary.prePost.declinedPercent)}</b>
            </li>
          </ul>
        </>
      )}
    </div>

    <div className="evidence-block">
      <p className="evidence-block-title">ผลการเล่นเกมหลัก</p>
      {/* Raw individual knowledge only — Boss (/3), team competition scores and item modifiers
          never enter this figure. */}
      <dl className="evidence-grid">
        <div><dt>คะแนนเฉลี่ย</dt><dd>{formatAverage(summary.main.averageScore, 2)}/{summary.main.totalCount}</dd></div>
        <div><dt>ทำกิจกรรมหลักครบ</dt><dd>{formatCountWithPercent(summary.main.completedCount, summary.totalStudents)}</dd></div>
      </dl>
    </div>

    {/* Reported on its own. Never compared with Main or with pre/post. */}
    <div className="evidence-block">
      <p className="evidence-block-title">ผลการทบทวน</p>
      <dl className="evidence-grid">
        <div><dt>คะแนนเฉลี่ย</dt><dd>{formatAverage(summary.recall.averageCorrect, 2)}/{summary.recall.totalCount}</dd></div>
        <div><dt>ทำการทบทวนครบ</dt><dd>{formatCountWithPercent(summary.recall.completedCount, summary.totalStudents)}</dd></div>
      </dl>
    </div>

    <div className="evidence-block">
      <p className="evidence-block-title">
        แบบประเมินกิจกรรม
        <span>ทำแบบประเมินครบ {formatCountWithPercent(summary.survey.completedCount, summary.totalStudents)}</span>
      </p>
      {summary.survey.responseCount === 0 ? (
        <p className="evidence-empty">ไม่มีแบบประเมินที่ทำครบทุกข้อในรอบนี้</p>
      ) : (
        <>
          <dl className="evidence-grid">
            <div><dt>ค่าเฉลี่ยรวม</dt><dd>{formatAverage(summary.survey.overallAverage, 2)}/5</dd></div>
          </dl>
          <ul className="evidence-survey-items">
            {summary.survey.items.map((item, index) => (
              <li key={item.itemId}>
                <span className="evidence-survey-statement">{index + 1}. {item.statement}</span>
                <span className="evidence-survey-score">
                  {item.responseCount === 0 ? '-' : `${formatAverage(item.average, 2)}/5`}
                  <small>({item.responseCount} คน)</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>

      </>
    )}

    {sections === 'class' ? null : (
    <div className="evidence-block">
      <p className="evidence-block-title">รายบุคคล</p>
      {summary.students.length === 0 ? (
        <p className="evidence-empty">ไม่มีข้อมูลนักเรียนในรอบนี้</p>
      ) : (
        <div className="learning-history-scroll">
          <table className="learning-history-table">
            <thead>
              <tr>
                <th>ชื่อ</th>
                <th>ก่อนเรียน</th>
                <th>หลังเรียน</th>
                <th>ผลต่าง</th>
                <th>เกมหลัก</th>
                <th>ทำเกมครบ</th>
                <th>ประเมินครบ</th>
              </tr>
            </thead>
            <tbody>
              {summary.students.map((student) => (
                <tr key={student.playerId}>
                  <td className="text-[#fff7df]">{student.displayName}</td>
                  {/* "-" for an unfinished or absent test: a partial score is not comparable, and
                      a round predating the assessment layer has no score at all. */}
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
        </div>
      )}
    </div>
    )}
  </div>
)
