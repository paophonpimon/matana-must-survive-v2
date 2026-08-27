import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EvidenceSummaryPanel } from './EvidenceSummaryPanel'
import { formatAverage, formatPercent, type EvidenceSummary } from '../lib/evidenceSummary'
import type { ClassRecallSummary } from '../lib/learning'
import type { TeamCompetitionStat } from '../lib/magic'
import type { TeamStat } from '../lib/teamScoring'
import type { Player, RoomStatus } from '../types/game'

// Teacher final-result screen — "ศูนย์บัญชาการ" command centre.
//
// SUMMARY FIRST → DETAILS ON DEMAND. The first viewport (target 1180×820 landscape tablet) must be
// readable in a few seconds: compact header, compact result hero, four tabs, and the room controls
// pinned at the bottom. Only the active tab expands; long content (the roster) scrolls INSIDE its
// panel so the page itself never grows tall.
//
// This component is presentational only. Every number it renders is passed in already-computed by
// the page — team ranking from computeTeamCompetitionStats, evidence from the single shared
// computeEvidenceSummaryFromSources aggregation, recall from computeClassRecallSummary. Nothing is
// derived, re-averaged or combined here, so the screen cannot drift from the printout or the
// workbook, and no unofficial score can be invented by the UI.

const TABS = [
  { id: 'summary', label: 'สรุปผลรอบนี้' },
  { id: 'evidence', label: 'สรุปหลักฐานการเรียนรู้' },
  { id: 'teams', label: 'กระดานคะแนนทุกทีม' },
  { id: 'students', label: 'รายบุคคล' },
] as const

type TabId = (typeof TABS)[number]['id']

// Ranks 1–3 have approved emblem artwork; every lower rank uses a plain CSS chip rather than
// inventing artwork that does not exist.
const RANK_EMBLEM_SRC: Record<number, string> = {
  1: '/assets/teacher-result/rank-1-emblem.png',
  2: '/assets/teacher-result/rank-2-emblem.png',
  3: '/assets/teacher-result/rank-3-emblem.png',
}

// The rank NUMBER is real HTML text layered over the (empty-centred) emblem art — never baked into
// the image, so it stays selectable, translatable and correct for any rank.
const RankBadge = ({ rank, size = 'md' }: { rank: number; size?: 'sm' | 'md' | 'lg' }) => {
  const emblem = RANK_EMBLEM_SRC[rank]
  return (
    <span className={`rcc-rank-badge rcc-rank-badge-${size} ${emblem ? '' : 'rcc-rank-badge-plain'}`}>
      {emblem ? <img src={emblem} alt="" aria-hidden="true" /> : null}
      <b aria-label={`อันดับ ${rank}`}>{rank}</b>
    </span>
  )
}

interface TeacherResultCommandCenterProps {
  round: number
  roomStatus: RoomStatus
  competitionStats: TeamCompetitionStat[]
  teamStatsById: Map<string, TeamStat>
  players: Player[]
  teamDisplayName: (teamId: string) => string
  recallSummary: ClassRecallSummary
  recallLabelFor: (conceptId: string) => string
  // Null until a round has genuinely completed — a merely closed room may have been abandoned
  // mid-activity, and its partial numbers would read as real results.
  evidence: EvidenceSummary | null
  busy: boolean
  onPrint: () => void
  onExportExcel: () => void
  demo?: boolean
  // Provenance banner for the reconstructed class-reporting sample. `banner` shows at the top of
  // the screen; `individual` shows above the per-student table so the reconstructed rows are never
  // read as original measured records. Undefined for every live/demo/historical caller.
  provenanceNotice?: { banner: string; individual: string }
  // Live-room controls. Omitted entirely in historical mode — a recorded round has nothing to
  // prepare and nothing to end, and offering either would imply this screen can still mutate it.
  onPrepareNextRound?: () => void
  onCloseRoom?: () => void
  // Rendered instead of ยุติห้อง once the room is already closed.
  closedRoomAction?: React.ReactNode
  // Read-only reconstruction of a stored round. Swaps the room controls for a way back to the
  // history list, and drops the room-history utility (you are already inside it).
  historical?: {
    roomCode: string
    onBack: () => void
  }
}

export const TeacherResultCommandCenter = ({
  round,
  roomStatus,
  competitionStats,
  teamStatsById,
  players,
  teamDisplayName,
  recallSummary,
  recallLabelFor,
  evidence,
  busy,
  onPrint,
  onExportExcel,
  onPrepareNextRound,
  onCloseRoom,
  closedRoomAction,
  historical,
  demo = false,
  provenanceNotice,
}: TeacherResultCommandCenterProps) => {
  const [tab, setTab] = useState<TabId>('summary')

  const champion = competitionStats[0] ?? null
  const runnerUp = competitionStats[1] ?? null
  // Ties are real: several teams can share the top competition score. The hero names the first and
  // states the tie rather than silently picking a winner.
  const tiedWithChampion = champion
    ? competitionStats.filter((team) => team.competitionAverage === champion.competitionAverage && team.memberCount > 0)
    : []
  const isTie = tiedWithChampion.length > 1

  return (
    <div className="rcc-cc">
      {demo ? <div className="rcc-demo-label">โหมดสาธิต — ข้อมูลจำลอง</div> : null}
      {provenanceNotice ? <div className="rcc-provenance-label">{provenanceNotice.banner}</div> : null}
      {/* ── Compact result hero ─────────────────────────────────────────────── */}
      <section className="rcc-hero" aria-label="ผลภารกิจรอบนี้">
        <div className="rcc-hero-round">
          {/* Deliberately NOT a rank emblem: rank artwork means team ranking, and reusing it for
              the round number read as a second, competing ranking badge. */}
          <span className="rcc-hero-round-label">ประกาศผลภารกิจรอบที่</span>
          <span className="rcc-hero-round-value">{round}</span>
        </div>

        {champion ? (
          <div className="rcc-hero-champion">
            <RankBadge rank={1} size="lg" />
            <div className="rcc-hero-champion-body">
              <small>{isTie ? `ทีมอันดับหนึ่ง · ${tiedWithChampion.length} ทีมคะแนนเท่ากัน` : 'ทีมอันดับหนึ่ง'}</small>
              <strong>{isTie ? tiedWithChampion.map((team) => teamDisplayName(team.id)).join(' · ') : teamDisplayName(champion.id)}</strong>
            </div>
            <div className="rcc-hero-champion-score">
              <small>คะแนนเฉลี่ย</small>
              <strong>{champion.competitionAverage.toFixed(1)}</strong>
            </div>
          </div>
        ) : (
          <div className="rcc-hero-champion rcc-hero-champion-empty">
            <p>ยังไม่มีทีมในรอบนี้</p>
          </div>
        )}

        {runnerUp && !isTie ? (
          <div className="rcc-hero-runner">
            <RankBadge rank={2} size="md" />
            <span className="rcc-hero-runner-body">
              <small>ทีมอันดับสอง</small>
              <strong>{teamDisplayName(runnerUp.id)}</strong>
            </span>
            <span className="rcc-hero-runner-score">
              <small>คะแนนเฉลี่ย</small>
              <strong>{runnerUp.competitionAverage.toFixed(1)}</strong>
            </span>
          </div>
        ) : null}
      </section>

      {/* ── Tabs + export utilities ─────────────────────────────────────────── */}
      <div className="rcc-navrow">
        <div className="rcc-tabs" role="tablist" aria-label="มุมมองผลการเรียนรู้">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`result-tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`result-panel-${entry.id}`}
              className={`rcc-tab ${tab === entry.id ? 'is-active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* Existing export behaviour, unchanged: PDF is the browser's own print/Save-as-PDF over
            the existing print view, and Excel is the existing workbook builder. */}
        <div className="rcc-utilities">
          <button type="button" className="rcc-utility" onClick={onPrint}>ดาวน์โหลด PDF</button>
          <button type="button" className="rcc-utility" onClick={onExportExcel}>ดาวน์โหลด Excel</button>
          {historical || demo ? null : <Link className="rcc-utility" to="/teacher/history">ประวัติห้อง</Link>}
        </div>
      </div>

      {/* ── Tab panels ──────────────────────────────────────────────────────── */}
      <div className="rcc-panel-frame">
        {tab === 'summary' ? (
          <div className="rcc-panel rcc-panel-summary" role="tabpanel" id="result-panel-summary" aria-labelledby="result-tab-summary">
            <section className="rcc-card">
              <h3 className="rcc-card-title"><span className="rcc-card-key">A</span>ผลสรุปทีมอันดับหนึ่ง</h3>
              {champion ? (
                <>
                  <div className="rcc-champion-block">
                    <RankBadge rank={1} size="md" />
                    <small>ทีมอันดับหนึ่ง</small>
                    <strong>{isTie ? tiedWithChampion.map((team) => teamDisplayName(team.id)).join(' · ') : teamDisplayName(champion.id)}</strong>
                    <small>คะแนนเฉลี่ย</small>
                    <b>{champion.competitionAverage.toFixed(1)}</b>
                  </div>
                  {runnerUp && !isTie ? (
                    <div className="rcc-runner-row">
                      <RankBadge rank={2} size="sm" />
                      <span>{teamDisplayName(runnerUp.id)}</span>
                      <b>{runnerUp.competitionAverage.toFixed(1)}<small>เฉลี่ย</small></b>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="rcc-empty">ยังไม่มีทีมในรอบนี้</p>
              )}
            </section>

            <section className="rcc-card">
              <h3 className="rcc-card-title"><span className="rcc-card-key">B</span>ผลการทบทวน รายหัวข้อ</h3>
              <ul className="rcc-topic-list">
                {recallSummary.concepts.map((concept) => (
                  <li key={concept.conceptId}>
                    <span>{recallLabelFor(concept.conceptId)}</span>
                    <b>ตอบถูก {concept.recallCorrectCount}/{concept.totalStudents}</b>
                  </li>
                ))}
              </ul>
              <img className="rcc-topic-divider" src="/assets/teacher-result/thai-divider-gold.png" alt="" aria-hidden="true" />
              {/* Ranked by review accuracy alone — a review-difficulty signal, never a statement
                  about learning or change. Both values come straight from the existing summary. */}
              <div className="rcc-topic-extremes">
                <div><small>ทบทวนได้ดีที่สุด</small><strong>{recallSummary.strongestConceptId ? recallLabelFor(recallSummary.strongestConceptId) : '—'}</strong></div>
                <div><small>ทบทวนได้น้อยที่สุด</small><strong>{recallSummary.weakestConceptId ? recallLabelFor(recallSummary.weakestConceptId) : '—'}</strong></div>
              </div>
            </section>

            <section className="rcc-card">
              <h3 className="rcc-card-title"><span className="rcc-card-key">C</span>หลักฐานการเรียนรู้ (ภาพรวม)</h3>
              {/* A preview of the SAME four evidence categories tab 2 reports in full. Every value
                  is read from the shared summary; an unavailable figure reads "—", never 0. */}
              <div className="rcc-evidence-grid">
                <article className="rcc-evidence-cell">
                  <span className="rcc-medallion"><img src="/assets/teacher-result/summary-icon-medallion.png" alt="" aria-hidden="true" /><i aria-hidden="true">📖</i></span>
                  <small>ก่อนเรียน / หลังเรียน</small>
                  <strong>
                    {evidence && evidence.prePost.comparedCount > 0
                      ? `${formatAverage(evidence.prePost.preAverage, 2)} → ${formatAverage(evidence.prePost.postAverage, 2)}`
                      : '—'}
                  </strong>
                  {evidence && evidence.prePost.comparedCount > 0 ? (
                    <em className="rcc-evidence-trace">
                      สูงขึ้น {evidence.prePost.improvedCount}/{evidence.prePost.comparedCount} · {formatPercent(evidence.prePost.improvedPercent)}
                    </em>
                  ) : null}
                </article>
                <article className="rcc-evidence-cell">
                  <span className="rcc-medallion"><img src="/assets/teacher-result/summary-icon-medallion.png" alt="" aria-hidden="true" /><i aria-hidden="true">🎮</i></span>
                  <small>ผลการเล่นเกมหลัก</small>
                  <strong>{evidence ? `${formatAverage(evidence.main.averageScore, 2)}/${evidence.main.totalCount}` : '—'}</strong>
                  {evidence ? (
                    <em className="rcc-evidence-trace">
                      ทำครบ {evidence.main.completedCount}/{evidence.totalStudents} · {formatPercent(evidence.main.completionPercent)}
                    </em>
                  ) : null}
                </article>
                <article className="rcc-evidence-cell">
                  <span className="rcc-medallion"><img src="/assets/teacher-result/summary-icon-medallion.png" alt="" aria-hidden="true" /><i aria-hidden="true">📋</i></span>
                  <small>ผลการทบทวน</small>
                  <strong>{evidence ? `${formatAverage(evidence.recall.averageCorrect, 2)}/${evidence.recall.totalCount}` : '—'}</strong>
                  {evidence ? (
                    <em className="rcc-evidence-trace">
                      ทำครบ {evidence.recall.completedCount}/{evidence.totalStudents} · {formatPercent(evidence.recall.completionPercent)}
                    </em>
                  ) : null}
                </article>
                <article className="rcc-evidence-cell">
                  <span className="rcc-medallion"><img src="/assets/teacher-result/summary-icon-medallion.png" alt="" aria-hidden="true" /><i aria-hidden="true">📝</i></span>
                  <small>แบบประเมินกิจกรรม</small>
                  <strong>{evidence && evidence.survey.responseCount > 0 ? `${formatAverage(evidence.survey.overallAverage, 2)}/5` : '—'}</strong>
                  {evidence ? (
                    <em className="rcc-evidence-trace">
                      ทำครบ {evidence.survey.completedCount}/{evidence.totalStudents} · {formatPercent(evidence.survey.completionPercent)}
                    </em>
                  ) : null}
                </article>
              </div>
              {!evidence ? <p className="rcc-empty">สรุปหลักฐานจะแสดงเมื่อรอบนี้จบสมบูรณ์</p> : null}
            </section>
          </div>
        ) : null}

        {tab === 'evidence' ? (
          <div className="rcc-panel rcc-panel-scroll" role="tabpanel" id="result-panel-evidence" aria-labelledby="result-tab-evidence">
            {evidence ? (
              <EvidenceSummaryPanel summary={evidence} title="สรุปหลักฐานการเรียนรู้" sections="class" />
            ) : (
              <p className="rcc-empty">ยังไม่มีสรุปหลักฐานสำหรับรอบนี้ — จะแสดงเมื่อรอบจบสมบูรณ์</p>
            )}
          </div>
        ) : null}

        {tab === 'teams' ? (
          <div className="rcc-panel rcc-panel-scroll" role="tabpanel" id="result-panel-teams" aria-labelledby="result-tab-teams">
            {competitionStats.length === 0 ? (
              <p className="rcc-empty">ยังไม่มีทีมในรอบนี้</p>
            ) : (
              <ol className="rcc-team-board">
                {competitionStats.map((team, index) => {
                  const rank = index + 1
                  const fullGame = teamStatsById.get(team.id)
                  return (
                    <li key={team.id} className={`rcc-team-row ${rank === 1 ? 'is-champion' : ''}`}>
                      <RankBadge rank={rank} size="sm" />
                      <div className="rcc-team-identity">
                        <strong>{teamDisplayName(team.id)}</strong>
                        <small>
                          {team.memberCount} คน · เล่นจบ {fullGame?.submittedCount ?? 0}/{team.memberCount} · ถูก {fullGame?.correctCount ?? 0} ข้อ
                        </small>
                      </div>
                      <div className="rcc-team-score">
                        <small>คะแนนเฉลี่ย</small>
                        <strong>{team.competitionAverage.toFixed(1)}</strong>
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        ) : null}

        {tab === 'students' ? (
          <div className="rcc-panel rcc-panel-scroll" role="tabpanel" id="result-panel-students" aria-labelledby="result-tab-students">
            {/* The EXISTING per-student evidence view — not a leaderboard. Same rows, same
                completeness semantics, rendered from the same shared summary as tab 2. */}
            {provenanceNotice ? <p className="rcc-panel-note rcc-provenance-note">{provenanceNotice.individual}</p> : null}
            {evidence ? (
              <EvidenceSummaryPanel summary={evidence} title="รายบุคคล" sections="students" hideHeading />
            ) : (
              <p className="rcc-empty">ยังไม่มีข้อมูลรายบุคคลสำหรับรอบนี้ — จะแสดงเมื่อรอบจบสมบูรณ์</p>
            )}
            <p className="rcc-panel-note">นักเรียนทั้งหมด {players.length} คน</p>
          </div>
        ) : null}
      </div>

      {/* ── Room controls, always visible without scrolling ─────────────────── */}
      {/* Historical mode is strictly read-only: a recorded round has nothing to prepare and
          nothing to end, so neither control is rendered at all — not merely disabled. The only
          action offered is the way back to the history list. */}
      <div className="rcc-roombar">
        <img className="rcc-roombar-rose rcc-roombar-rose-left" src="/assets/teacher-result/result-rose-cluster-left.png" alt="" aria-hidden="true" />
        <div className="rcc-roombar-actions">
          {historical ? (
            <>
              <span className="rcc-roombar-note">
                {provenanceNotice ? `${provenanceNotice.banner} · อ่านอย่างเดียว` : `ผลย้อนหลัง ห้อง ${historical.roomCode} · อ่านอย่างเดียว`}
              </span>
              <button type="button" className="rcc-room-primary" onClick={historical.onBack}>
                {provenanceNotice ? 'กลับหน้าแรก' : 'กลับไปประวัติห้อง'}
              </button>
            </>
          ) : (
            <>
              {roomStatus === 'completed' && onPrepareNextRound ? (
                <button type="button" className="rcc-room-primary" onClick={onPrepareNextRound} disabled={busy}>เตรียมภารกิจรอบใหม่</button>
              ) : null}
              {roomStatus === 'closed' ? closedRoomAction : (
                onCloseRoom ? <button type="button" className="rcc-room-danger" onClick={onCloseRoom} disabled={busy}>ยุติห้อง</button> : null
              )}
            </>
          )}
        </div>
        <img className="rcc-roombar-rose rcc-roombar-rose-right" src="/assets/teacher-result/result-rose-cluster-right.png" alt="" aria-hidden="true" />
      </div>
    </div>
  )
}
