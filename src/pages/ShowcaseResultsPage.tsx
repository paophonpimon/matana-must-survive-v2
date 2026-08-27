import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrandHeader, ScenePage } from '../components/Layout'
import { TeacherReportPrintView } from '../components/TeacherReportPrintView'
import { TeacherResultCommandCenter } from '../components/TeacherResultCommandCenter'
import { recallQuestionsById } from '../data/recallQuestions'
import { computeEvidenceSummaryFromHistory } from '../lib/evidenceSummary'
import { downloadLearningWorkbook } from '../lib/learningExport'
import { computeClassRecallSummary } from '../lib/learning'
import { computeTeamCompetitionStats } from '../lib/magic'
import {
  historyToDerivedPlayers,
  historyToPrintablePlayers,
  questionIdsFromHistory,
  teamNamesFromHistory,
  teamsFromHistory,
} from '../lib/roomHistory'
import {
  SAMPLE_RESULTS_HEADLINE,
  SAMPLE_RESULTS_INDIVIDUAL_NOTE,
  SAMPLE_RESULTS_LABEL,
  SAMPLE_RESULTS_ROUND,
  SAMPLE_RESULTS_SUBHEAD,
  buildSampleResultsHistory,
} from '../lib/showcaseResults'
import { computeTeamStats } from '../lib/teamScoring'
import type { Player } from '../types/game'

// "ตัวอย่างผลลัพธ์ระดับชั้น 30 คน" — a full-class demonstration of the Teacher Result reporting
// system (command centre + print + spreadsheet), rendered entirely from a committed local dataset.
//
// PROVENANCE, shown on every surface: the class-level aggregates are treated as real classroom-use
// results; the P01–P30 per-participant rows are RECONSTRUCTED to reproduce them and are labelled
// as such — never presented as original measured student records, never attached to a real name.
//
// This page touches NOTHING outside itself: no GameProvider, no service, no Firebase, no history
// store, no gameplay. It is pure computation over `buildSampleResultsHistory()` through the exact
// same aggregators a real recorded round goes through when opened from ประวัติห้อง.
export const ShowcaseResultsPage = () => {
  const navigate = useNavigate()
  const [printing, setPrinting] = useState(false)

  const entries = useMemo(() => buildSampleResultsHistory(), [])
  const evidence = useMemo(() => computeEvidenceSummaryFromHistory(entries), [entries])
  const derivedPlayers = useMemo(() => historyToDerivedPlayers(entries), [entries])
  const teams = useMemo(() => teamsFromHistory(entries), [entries])
  const teamNames = useMemo(() => teamNamesFromHistory(entries), [entries])
  const questionIds = useMemo(() => questionIdsFromHistory(entries), [entries])
  const printPlayers = useMemo(() => historyToPrintablePlayers(entries), [entries])

  const teamStatsById = useMemo(
    () => new Map(computeTeamStats(derivedPlayers as unknown as Player[], teams).map((team) => [team.id, team])),
    [derivedPlayers, teams],
  )
  const competitionStats = useMemo(
    () => computeTeamCompetitionStats(derivedPlayers as unknown as Player[], teams, questionIds, [], SAMPLE_RESULTS_ROUND),
    [derivedPlayers, teams, questionIds],
  )
  const recallSummary = useMemo(
    () => computeClassRecallSummary(derivedPlayers as unknown as Player[]),
    [derivedPlayers],
  )

  const handlePrint = useCallback(() => {
    setPrinting(true)
    window.setTimeout(() => {
      window.print()
      setPrinting(false)
    }, 60)
  }, [])

  const provenanceBanner = `${SAMPLE_RESULTS_HEADLINE} · ${SAMPLE_RESULTS_SUBHEAD}`

  return (
    <ScenePage compact className="teacher-final-page showcase-results-page">
      <BrandHeader />
      <div className="teacher-shell mx-auto w-full max-w-7xl flex-1 px-5 pt-4 sm:px-8">
        <header className="showcase-results-header">
          <p className="showcase-results-eyebrow">{SAMPLE_RESULTS_SUBHEAD}</p>
          <h1>{SAMPLE_RESULTS_HEADLINE}</h1>
          <p className="showcase-results-lede">
            สาธิตระบบรายงานผลด้วยชุดข้อมูล 30 คนแบบครบทุกมุมมอง — ผลสรุประดับชั้น หลักฐานการเรียนรู้
            รายบุคคล รายข้อ ทีม และการส่งออก
          </p>
        </header>

        <TeacherResultCommandCenter
          round={SAMPLE_RESULTS_ROUND}
          roomStatus="completed"
          competitionStats={competitionStats}
          teamStatsById={teamStatsById}
          players={derivedPlayers as unknown as Player[]}
          teamDisplayName={(teamId) => teamNames.get(teamId) ?? teamId}
          recallSummary={recallSummary}
          recallLabelFor={(conceptId) => recallQuestionsById.get(conceptId)?.label ?? conceptId}
          evidence={evidence}
          busy={false}
          onPrint={handlePrint}
          onExportExcel={() => downloadLearningWorkbook(entries, SAMPLE_RESULTS_LABEL, { sample: true })}
          historical={{ roomCode: SAMPLE_RESULTS_LABEL, onBack: () => navigate('/') }}
          provenanceNotice={{ banner: provenanceBanner, individual: SAMPLE_RESULTS_INDIVIDUAL_NOTE }}
        />
      </div>

      {printing ? (
        <TeacherReportPrintView
          roomCode={SAMPLE_RESULTS_LABEL}
          round={SAMPLE_RESULTS_ROUND}
          players={printPlayers}
          questionIds={questionIds}
          teamNameById={teamNames}
          evidence={evidence}
          strongestConceptLabel={recallSummary.strongestConceptId ? recallQuestionsById.get(recallSummary.strongestConceptId)?.label ?? '-' : '-'}
          weakestConceptLabel={recallSummary.weakestConceptId ? recallQuestionsById.get(recallSummary.weakestConceptId)?.label ?? '-' : '-'}
          provenanceLabel={SAMPLE_RESULTS_SUBHEAD}
        />
      ) : null}
    </ScenePage>
  )
}
