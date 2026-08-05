import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { deleteApp, initializeApp } from 'firebase/app'
import { deleteUser, getAuth, signInAnonymously } from 'firebase/auth'
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  runTransaction,
  setDoc,
  writeBatch,
} from 'firebase/firestore'

const STUDENT_COUNT = 40
const TIMEOUT_MS = 30_000

const envText = await readFile(new URL('../.env.local', import.meta.url), 'utf8')
const env = Object.fromEntries(envText.split(/\r?\n/).filter(Boolean).map((line) => {
  const separator = line.indexOf('=')
  return [line.slice(0, separator), line.slice(separator + 1)]
}))

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
}

if (Object.values(firebaseConfig).some((value) => !value)) throw new Error('Firebase configuration is incomplete')

const roomCode = `L${Date.now().toString(36).slice(-5)}`.toUpperCase()
const questionIds = Array.from({ length: 10 }, (_, index) => `load-q${index + 1}`)
const apps = []
const clients = []
const phaseResults = {}

const percentile = (values, ratio) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)].toFixed(1))
}

const summarize = (durations, failures) => ({
  success: durations.length,
  failed: failures.length,
  p50Ms: percentile(durations, 0.5),
  p95Ms: percentile(durations, 0.95),
  maxMs: durations.length ? Number(Math.max(...durations).toFixed(1)) : null,
  errors: [...new Set(failures.map((failure) => failure.message))],
})

const runConcurrent = async (name, items, operation) => {
  const durations = []
  const failures = []
  const wallStartedAt = performance.now()
  await Promise.all(items.map(async (item, index) => {
    const startedAt = performance.now()
    try {
      await operation(item, index)
      durations.push(performance.now() - startedAt)
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }))
  phaseResults[name] = {
    ...summarize(durations, failures),
    wallMs: Number((performance.now() - wallStartedAt).toFixed(1)),
  }
  if (failures.length) throw new Error(`${name} failed for ${failures.length} clients: ${failures[0].message}`)
}

const waitForDocument = (reference, predicate) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    unsubscribe()
    reject(new Error(`Realtime document timeout: ${reference.path}`))
  }, TIMEOUT_MS)
  const unsubscribe = onSnapshot(reference, (snapshot) => {
    if (!snapshot.exists() || !predicate(snapshot.data())) return
    clearTimeout(timeout)
    unsubscribe()
    resolve()
  }, (error) => {
    clearTimeout(timeout)
    unsubscribe()
    reject(error)
  })
})

const waitForTeamQuery = (database, predicate) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    unsubscribe()
    reject(new Error('Realtime team query timeout'))
  }, TIMEOUT_MS)
  const unsubscribe = onSnapshot(collection(database, 'rooms', roomCode, 'teams'), (snapshot) => {
    if (!predicate(snapshot.docs.map((teamDocument) => teamDocument.data()))) return
    clearTimeout(timeout)
    unsubscribe()
    resolve()
  }, (error) => {
    clearTimeout(timeout)
    unsubscribe()
    reject(error)
  })
})

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

let teacher
let testError = null

try {
  const teacherApp = initializeApp(firebaseConfig, `load-teacher-${roomCode}`)
  apps.push(teacherApp)
  const teacherAuth = getAuth(teacherApp)
  const teacherCredential = await signInAnonymously(teacherAuth)
  const teacherDb = getFirestore(teacherApp)
  teacher = { app: teacherApp, auth: teacherAuth, db: teacherDb, uid: teacherCredential.user.uid }

  await setDoc(doc(teacherDb, 'rooms', roomCode), {
    roomCode,
    status: 'waiting',
    currentRound: 1,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    currentQuestionIndex: 0,
    questionDurationSeconds: 60,
    questionStartedAt: null,
    questionIds,
    previousQuestionIds: [],
    winner: null,
    teacherSessionId: teacher.uid,
  })

  const studentIndexes = Array.from({ length: STUDENT_COUNT }, (_, index) => index)
  await runConcurrent('anonymousAuth', studentIndexes, async (_, index) => {
    const app = initializeApp(firebaseConfig, `load-student-${roomCode}-${index}`)
    apps.push(app)
    const auth = getAuth(app)
    const credential = await signInAnonymously(auth)
    const db = getFirestore(app)
    clients[index] = { app, auth, db, uid: credential.user.uid, teamId: `load-team-${String(index + 1).padStart(2, '0')}` }
  })

  const teacherSawAllJoins = waitForTeamQuery(teacherDb, (teams) => teams.length === STUDENT_COUNT)
  await runConcurrent('joinRoom', clients, async (client, index) => {
    await setDoc(doc(client.db, 'rooms', roomCode, 'teams', client.teamId), {
      id: client.teamId,
      teamName: `กลุ่มทดสอบ ${index + 1}`,
      guardianName: `ผู้พิทักษ์ ${index + 1}`,
      joinedAt: Date.now(),
      currentRound: 1,
      currentQuestionIndex: 0,
      score: 0,
      answers: [],
      submitted: false,
      finishedAt: null,
      elapsedMs: null,
      status: 'waiting',
      ownerUid: client.uid,
    })
  })
  await teacherSawAllJoins

  const realtimeStartWaits = clients.map((client) => Promise.all([
    waitForDocument(doc(client.db, 'rooms', roomCode), (data) => data.status === 'playing'),
    waitForDocument(doc(client.db, 'rooms', roomCode, 'teams', client.teamId), (data) => data.status === 'playing'),
  ]))
  const startWall = performance.now()
  const startBatch = writeBatch(teacherDb)
  startBatch.update(doc(teacherDb, 'rooms', roomCode), {
    status: 'playing',
    startedAt: Date.now(),
    questionStartedAt: Date.now(),
  })
  clients.forEach((client) => startBatch.update(doc(teacherDb, 'rooms', roomCode, 'teams', client.teamId), { status: 'playing' }))
  await startBatch.commit()
  await Promise.all(realtimeStartWaits)
  phaseResults.realtimeStart = { success: STUDENT_COUNT, failed: 0, wallMs: Number((performance.now() - startWall).toFixed(1)) }

  const teacherSawAnswers = waitForTeamQuery(teacherDb, (teams) => teams.length === STUDENT_COUNT && teams.every((team) => team.score === 1 && team.answers?.length === 1))
  const studentSawOwnAnswer = clients.map((client) => waitForDocument(
    doc(client.db, 'rooms', roomCode, 'teams', client.teamId),
    (data) => data.score === 1 && data.answers?.length === 1,
  ))
  await runConcurrent('submitAnswer', clients, async (client) => {
    const roomReference = doc(client.db, 'rooms', roomCode)
    const teamReference = doc(client.db, 'rooms', roomCode, 'teams', client.teamId)
    await runTransaction(client.db, async (transaction) => {
      const [roomSnapshot, teamSnapshot] = await Promise.all([transaction.get(roomReference), transaction.get(teamReference)])
      if (roomSnapshot.data()?.status !== 'playing') throw new Error('Room is not playing')
      const team = teamSnapshot.data()
      transaction.update(teamReference, {
        answers: [{ questionId: questionIds[0], selectedChoiceId: 'a', isCorrect: true, answeredAt: Date.now() }],
        score: (team?.score ?? 0) + 1,
      })
    })
  })
  await Promise.all([...studentSawOwnAnswer, teacherSawAnswers])

  const teacherSawEdits = waitForTeamQuery(teacherDb, (teams) => teams.length === STUDENT_COUNT && teams.every((team) => team.score === 0 && team.answers?.length === 1))
  const studentSawOwnEdit = clients.map((client) => waitForDocument(
    doc(client.db, 'rooms', roomCode, 'teams', client.teamId),
    (data) => data.score === 0 && data.answers?.[0]?.selectedChoiceId === 'b',
  ))
  await runConcurrent('editAnswer', clients, async (client) => {
    const teamReference = doc(client.db, 'rooms', roomCode, 'teams', client.teamId)
    await runTransaction(client.db, async (transaction) => {
      const teamSnapshot = await transaction.get(teamReference)
      const team = teamSnapshot.data()
      transaction.update(teamReference, {
        answers: [{ questionId: questionIds[0], selectedChoiceId: 'b', isCorrect: false, answeredAt: Date.now() }],
        score: Math.max(0, (team?.score ?? 0) - 1),
      })
    })
  })
  await Promise.all([...studentSawOwnEdit, teacherSawEdits])

  const teamSnapshot = await getDocs(collection(teacherDb, 'rooms', roomCode, 'teams'))
  const finalTeams = teamSnapshot.docs.map((teamDocument) => teamDocument.data())
  phaseResults.finalVerification = {
    teamCount: finalTeams.length,
    oneAnswerPerTeam: finalTeams.every((team) => team.answers?.length === 1),
    latestAnswerApplied: finalTeams.every((team) => team.score === 0 && team.answers?.[0]?.selectedChoiceId === 'b'),
  }
} catch (error) {
  testError = error instanceof Error ? error : new Error(String(error))
} finally {
  if (teacher) {
    try {
      const closeBatch = writeBatch(teacher.db)
      closeBatch.update(doc(teacher.db, 'rooms', roomCode), { status: 'closed' })
      clients.forEach((client) => closeBatch.update(doc(teacher.db, 'rooms', roomCode, 'teams', client.teamId), { status: 'stopped' }))
      await closeBatch.commit()
    } catch {}
  }

  for (let index = 0; index < clients.length; index += 5) {
    await Promise.all(clients.slice(index, index + 5).map(async (client) => {
      try { if (client.auth.currentUser) await deleteUser(client.auth.currentUser) } catch {}
    }))
    await sleep(650)
  }
  try { if (teacher?.auth.currentUser) await deleteUser(teacher.auth.currentUser) } catch {}
  await Promise.all(apps.map(async (app) => { try { await deleteApp(app) } catch {} }))
}

console.log(JSON.stringify({ roomCode, students: STUDENT_COUNT, phases: phaseResults, error: testError?.message ?? null }, null, 2))
if (testError) process.exitCode = 1
