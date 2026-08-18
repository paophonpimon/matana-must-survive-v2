import type { EvidenceSummary } from '../lib/evidenceSummary'

interface EvidenceSummaryPanelProps {
  summary: EvidenceSummary
  title: string
  // Set when the figures come from a stored round-history snapshot rather than live players, so
  // the teacher can tell which source they are reading.
  sourceNote?: string
}

// Teacher evidence panel. Rendered for the just-finished round from live players, and for any
// stored round from round-history — identical markup either way, because both are handed the same
// EvidenceSummary shape produced by the same aggregation.
//
// Descriptive only: it reports what the scores were, never that the activity caused them. One
// classroom, no control group, no randomisation — so no causal wording and no inferential test.
export const EvidenceSummaryPanel = ({ summary, title, sourceNote }: EvidenceSummaryPanelProps) => (
  <div className="evidence-summary mt-6">
    <h3 className="evidence-summary-title">{title}</h3>
    <p className="evidence-summary-note">
      จำนวนนักเรียนทั้งหมด {summary.totalStudents} คน
      {sourceNote ? ` · ${sourceNote}` : ''}
    </p>

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
            <div><dt>ก่อนเรียน (เฉลี่ย)</dt><dd>{summary.prePost.preAverage.toFixed(1)}/{summary.prePost.totalCount}</dd></div>
            <div><dt>หลังเรียน (เฉลี่ย)</dt><dd>{summary.prePost.postAverage.toFixed(1)}/{summary.prePost.totalCount}</dd></div>
            <div><dt>ผลต่างเฉลี่ย</dt><dd>{summary.prePost.averageDifference >= 0 ? '+' : ''}{summary.prePost.averageDifference.toFixed(1)}</dd></div>
          </dl>
          <p className="evidence-summary-note">
            คะแนนหลังเรียนสูงกว่าก่อนเรียน {summary.prePost.improvedCount} คน ({summary.prePost.improvedPercent.toFixed(0)}%)
            {' · '}เท่าเดิม {summary.prePost.unchangedCount} คน
            {' · '}ต่ำกว่า {summary.prePost.declinedCount} คน
          </p>
        </>
      )}
    </div>

    <div className="evidence-block">
      <p className="evidence-block-title">ผลการเล่นเกมหลัก</p>
      <dl className="evidence-grid">
        <div><dt>คะแนนเฉลี่ย</dt><dd>{summary.main.averageScore.toFixed(1)}/{summary.main.totalCount}</dd></div>
        <div><dt>ทำครบ 10 ข้อ</dt><dd>{summary.main.completedCount}/{summary.totalStudents} คน</dd></div>
      </dl>
    </div>

    {/* Reported on its own. Never compared with Main or with pre/post. */}
    <div className="evidence-block">
      <p className="evidence-block-title">ผลการทบทวน</p>
      <dl className="evidence-grid">
        <div><dt>คะแนนเฉลี่ย</dt><dd>{summary.recall.averageCorrect.toFixed(1)}/{summary.recall.totalCount}</dd></div>
        <div><dt>ทำครบทุกข้อ</dt><dd>{summary.recall.completedCount}/{summary.totalStudents} คน</dd></div>
      </dl>
    </div>

    <div className="evidence-block">
      <p className="evidence-block-title">
        แบบประเมินกิจกรรม
        <span>ทำครบ {summary.survey.completedCount} / {summary.totalStudents} คน</span>
      </p>
      {summary.survey.responseCount === 0 ? (
        <p className="evidence-empty">ไม่มีแบบประเมินที่ทำครบทุกข้อในรอบนี้</p>
      ) : (
        <>
          <dl className="evidence-grid">
            <div><dt>ค่าเฉลี่ยรวม</dt><dd>{summary.survey.overallAverage.toFixed(2)}/5</dd></div>
          </dl>
          <ul className="evidence-survey-items">
            {summary.survey.items.map((item, index) => (
              <li key={item.itemId}>
                <span className="evidence-survey-statement">{index + 1}. {item.statement}</span>
                <span className="evidence-survey-score">
                  {item.responseCount === 0 ? '-' : `${item.average.toFixed(2)}/5`}
                  <small>({item.responseCount} คน)</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>

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
  </div>
)
