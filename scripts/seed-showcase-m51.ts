/**
 * Seeds the ONE dedicated showcase round into Firestore.
 *
 *   npm run seed:showcase -- --teacherUid=<UID> --roster="C:\path\roster.csv"
 *
 * THE ROSTER IS NEVER COMMITTED. It is read at run time from a CSV outside this repository, so no
 * real student identity ever lives in version control. Only the SIMULATED scores are in the repo,
 * keyed by roster POSITION (studentNumber 1–30), never by person.
 *
 * WHAT IT WRITES — only ever under rooms/5101:
 *   rooms/5101                        room doc, status 'completed', showcaseMode: true
 *   rooms/5101/players/{studentId}    30 finished player records
 *   rooms/5101/roundHistory/{id}      30 durable evidence snapshots (production builder)
 *   rooms/5101/rosters/{teamId}       5 team rosters
 *   rooms/5101/teamNames/{teamId}     5 guardian names
 *
 * WHAT IT NEVER DOES:
 *   • never lists, reads, mutates or deletes any other room
 *   • never wipes a collection
 *   • never overwrites a room that is not marked showcaseMode (hard abort)
 *   • never writes the roster CSV anywhere inside the repository
 *
 * Aggregates are not stored — the app derives every average and percentage from these student
 * rows through the same shared aggregator the normal Result screen uses.
 *
 * Requires Firebase Admin credentials, because the room must be owned by the TEACHER's uid and
 * Firestore rules only let a client create a room owned by its own caller. Admin bypasses rules;
 * that is the whole reason a service account is needed rather than a browser token.
 */
import { buildRoundHistoryEntry, roundHistoryEntryId } from '../src/lib/roundHistory'
import {
  SHOWCASE_COMPLETED_AT,
  SHOWCASE_MODE_FIELD,
  SHOWCASE_QUESTION_IDS,
  SHOWCASE_ROOM_CODE,
  SHOWCASE_ROUND,
  SHOWCASE_TEAMS,
  assertShowcaseRoster,
  buildShowcasePlayers,
  showcaseTeamNameFor,
} from '../src/lib/showcaseRound'
import { readRosterCsv } from './readRosterCsv'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`))
  return match ? match.slice(name.length + 3) : undefined
}
const has = (name: string): boolean => args.includes(`--${name}`)

const teacherUid = flag('teacherUid')
const rosterPath = flag('roster')
const className = flag('className') ?? 'ม.5/1'
const serviceAccountPath = flag('serviceAccount') ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
const projectId = flag('project') ?? process.env.FIREBASE_PROJECT_ID ?? 'matana-survive'
const dryRun = has('dry-run')

const fail = (message: string): never => {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

const banner = (): void => {
  console.log('─'.repeat(78))
  console.log('  SHOWCASE ROUND SEED')
  console.log('  ⚠  SIMULATED SHOWCASE DATA — NOT MEASURED CLASSROOM RESULTS')
  console.log('     Roster identities are read from an external CSV; every score is simulated.')
  console.log('─'.repeat(78))
}

const main = async (): Promise<void> => {
  banner()

  if (!teacherUid) {
    fail(
      'Missing --teacherUid=<UID>.\n'
      + '  The showcase room must be owned by the teacher who will present it, through the\n'
      + '  existing teacherSessionId ownership model. Find it by signing in to the hosted app\n'
      + '  as that teacher and reading the Firebase Auth uid.',
    )
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(teacherUid as string)) {
    fail(`--teacherUid looks malformed: ${teacherUid}`)
  }
  if (!rosterPath) {
    fail(
      'Missing --roster="<path to roster CSV>".\n'
      + '  The real roster is deliberately NOT stored in this repository. Point this at the CSV\n'
      + '  on your machine; keep it outside the repo (or in an ignored folder).\n'
      + '  Expected columns: studentId,firstName,lastName,className,studentNumber',
    )
  }

  // ── Read the roster from OUTSIDE the repo, then validate before building anything ────────────
  const roster = await readRosterCsv({ path: rosterPath as string, className })
  try {
    assertShowcaseRoster(roster)
  } catch (error) {
    return fail(`roster from ${rosterPath} (className "${className}") is unusable: ${(error as Error).message}`)
  }

  const players = buildShowcasePlayers(roster)
  const historyEntries = players.map((player) =>
    buildRoundHistoryEntry(
      player,
      SHOWCASE_ROUND,
      player.teamId ? showcaseTeamNameFor(player.teamId) : '',
      SHOWCASE_COMPLETED_AT,
    ))

  const roomDoc = {
    roomCode: SHOWCASE_ROOM_CODE,
    status: 'completed',
    phase: 'survey',
    currentRound: SHOWCASE_ROUND,
    createdAt: SHOWCASE_COMPLETED_AT,
    startedAt: SHOWCASE_COMPLETED_AT,
    completedAt: SHOWCASE_COMPLETED_AT,
    currentQuestionIndex: SHOWCASE_QUESTION_IDS.length,
    questionDurationSeconds: 30,
    questionStartedAt: null,
    questionClosedAt: null,
    recallQuestionDurationSeconds: 15,
    recallQuestionIndex: 5,
    recallQuestionStartedAt: null,
    assessmentSecondsPerQuestion: 30,
    preTestStartedAt: SHOWCASE_COMPLETED_AT,
    postTestStartedAt: SHOWCASE_COMPLETED_AT,
    bossQuestionIds: [],
    bossQuestionIndex: 0,
    bossQuestionStartedAt: null,
    bossQuestionDurationSeconds: 12,
    bossCompleted: false,
    bossWinner: null,
    bossAwaitingContinue: false,
    questionIds: SHOWCASE_QUESTION_IDS,
    previousQuestionIds: [],
    winner: null,
    teacherSessionId: teacherUid,
    teamCount: SHOWCASE_TEAMS.length,
    teamsLocked: true,
    teams: SHOWCASE_TEAMS,
    // Provenance marker. Gameplay reads nothing from this — it exists so the room is
    // unmistakably identifiable as presentation data, and so this script can refuse to
    // overwrite anything that is NOT the showcase.
    [SHOWCASE_MODE_FIELD]: true,
  }

  console.log(`\n  room code        : ${SHOWCASE_ROOM_CODE}`)
  console.log(`  project          : ${projectId}`)
  console.log(`  teacher uid      : ${teacherUid}`)
  console.log(`  roster source    : ${rosterPath} (className "${className}")`)
  console.log(`  players          : ${players.length}`)
  console.log(`  roundHistory     : ${historyEntries.length}`)
  console.log(`  teams            : ${SHOWCASE_TEAMS.length}`)
  console.log(`  main questions   : ${SHOWCASE_QUESTION_IDS.length}`)

  if (dryRun) {
    console.log('\n  --dry-run: nothing was written. Document shapes built successfully.\n')
    return
  }

  if (!serviceAccountPath) {
    fail(
      'No Firebase Admin credentials.\n'
      + '  Set GOOGLE_APPLICATION_CREDENTIALS=<path to service-account.json>, or pass\n'
      + '  --serviceAccount=<path>. Admin credentials are required because the room must be\n'
      + '  owned by the teacher uid, which Firestore rules forbid a client from doing.\n'
      + '  Never commit the key file.',
    )
  }

  let admin: typeof import('firebase-admin')
  try {
    admin = (await import('firebase-admin')).default as unknown as typeof import('firebase-admin')
  } catch {
    return fail('firebase-admin is not installed. Run:  npm i -D firebase-admin')
  }

  const { readFile } = await import('node:fs/promises')
  let credentials: Record<string, unknown>
  try {
    credentials = JSON.parse(await readFile(serviceAccountPath as string, 'utf8')) as Record<string, unknown>
  } catch (error) {
    return fail(`could not read service account at ${serviceAccountPath}: ${(error as Error).message}`)
  }

  admin.initializeApp({ credential: admin.credential.cert(credentials as never), projectId })
  const db = admin.firestore()
  const roomRef = db.collection('rooms').doc(SHOWCASE_ROOM_CODE)

  // ── Refuse to touch anything that is not the showcase room ───────────────────────────────────
  const existing = await roomRef.get()
  if (existing.exists) {
    const data = existing.data() ?? {}
    if (data[SHOWCASE_MODE_FIELD] !== true) {
      fail(
        `rooms/${SHOWCASE_ROOM_CODE} already exists and is NOT marked ${SHOWCASE_MODE_FIELD}.\n`
        + '  Refusing to overwrite what may be a real classroom room. Choose a different code\n'
        + '  or remove that room manually if it is genuinely disposable.',
      )
    }
    console.log(`\n  existing showcase room found — re-seeding (replacing its round ${SHOWCASE_ROUND} data)`)
  }

  // ── Write. One batch, scoped entirely under rooms/{SHOWCASE_ROOM_CODE} ───────────────────────
  const batch = db.batch()
  batch.set(roomRef, roomDoc)

  players.forEach((player) => {
    batch.set(roomRef.collection('players').doc(player.id), player as unknown as Record<string, unknown>)
  })
  historyEntries.forEach((entry) => {
    batch.set(roomRef.collection('roundHistory').doc(roundHistoryEntryId(SHOWCASE_ROUND, entry.playerId)), entry)
  })
  SHOWCASE_TEAMS.forEach((team) => {
    const members = players
      .filter((player) => player.teamId === team.id)
      .map((player) => ({ playerId: player.id, displayName: player.displayName }))
    batch.set(roomRef.collection('rosters').doc(team.id), { teamName: team.name, members })
    batch.set(roomRef.collection('teamNames').doc(team.id), {
      teamId: team.id,
      name: showcaseTeamNameFor(team.id),
      updatedAt: SHOWCASE_COMPLETED_AT,
      updatedByPlayerId: teacherUid,
    })
  })

  await batch.commit()

  console.log('\n  ✔ showcase round seeded')
  console.log(`\n  Open it from the hosted teacher UI:  ประวัติห้อง → room ${SHOWCASE_ROOM_CODE}`)
  console.log('  ⚠  Remember: the evidence in this room is SIMULATED SHOWCASE DATA.\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
