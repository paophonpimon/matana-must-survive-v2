/**
 * Drives N bot students through a REAL room, using the app's own FirebaseGameService.
 *
 *   npm run bots -- --room=7142 --count=10
 *
 * The bots call exactly the methods the browser calls — joinRoom, castCaptainVote,
 * chooseStartingItem, savePreTestAnswer, saveRecallAnswer, saveAnswer, saveBossAnswer,
 * savePostTestAnswer, saveSurveyResponse — so this exercises the production code path and the
 * live Firestore rules, not a parallel imitation of them.
 *
 * They react to room.phase the way students do; the TEACHER still drives every transition from
 * their own screen. Nothing here starts, advances or ends anything.
 *
 * Human-ish, deliberately: staggered joins, a think-time pause before each answer, and a per-bot
 * accuracy so the class produces a spread rather than 10 identical perfect scores.
 */
import { questionsById } from '../src/data/questions'
import { RECALL_QUESTIONS } from '../src/data/recallQuestions'
import { PRE_TEST_QUESTIONS, POST_TEST_QUESTIONS } from '../src/data/assessmentQuestions'
import { SURVEY_ITEMS, SURVEY_SCALE } from '../src/data/surveyItems'
import { bossQuestionsById } from '../src/data/bossQuestions'
import { getGameServicePromise } from '../src/services'
import type { Player, Room, TeamRosterSummary } from '../src/types/game'

const args = process.argv.slice(2)
const flag = (name: string, fallback?: string): string | undefined => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`))
  return match ? match.slice(name.length + 3) : fallback
}

const roomCode = (flag('room') ?? '').trim().toUpperCase()
const count = Number(flag('count', '10'))
// Each Node run signs in anonymously and therefore gets a NEW uid, so it can never re-adopt
// players a previous run created. If an earlier run left students behind, start from a free
// number rather than colliding with them.
const startNumber = Number(flag('startNumber', '1'))

if (!roomCode) {
  console.error('\n✖ ต้องระบุรหัสห้อง เช่น:  npm run bots -- --room=7142 --count=10\n')
  process.exit(1)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const rand = (min: number, max: number): number => min + Math.random() * (max - min)
/** Think time before answering. Real students are not instant and not uniform. */
const think = (): Promise<void> => sleep(rand(900, 3200))

const BOT_NAMES = [
  'บอทเอก', 'บอทโท', 'บอทตรี', 'บอทจัตวา', 'บอทเบญจ',
  'บอทฉัฏฐ์', 'บอทสัตต', 'บอทอัฐ', 'บอทนพ', 'บอททศ',
  'บอทเอกาทศ', 'บอททวาทศ', 'บอทไตรทศ', 'บอทจตุทศ', 'บอทปัญจทศ',
]

interface Bot {
  index: number
  player: Player
  /** Own player doc — a student may read their OWN record (ownerUid match). */
  me: Player | null
  /** Team roster — broadly readable by design, and the ONLY legal way a student sees teammates. */
  roster: TeamRosterSummary | null
  stopMe: (() => void) | null
  stopRoster: (() => void) | null
  /** Chance this bot answers a question correctly. Spread so the class looks like a class. */
  accuracy: number
  /** Cursors so a bot never re-answers or skips an item. */
  preDone: number
  postDone: number
  recallDone: Set<string>
  mainDone: Set<string>
  bossDone: Set<string>
  surveyDone: number
  votedFor: string | null
  namedTeam: boolean
  choseItem: boolean
}

const pickChoice = (
  question: { choices: Array<{ id: string }>; correctChoiceId: string },
  accuracy: number,
): string => {
  if (Math.random() < accuracy) return question.correctChoiceId
  const wrong = question.choices.filter((choice) => choice.id !== question.correctChoiceId)
  return wrong[Math.floor(Math.random() * wrong.length)]?.id ?? question.correctChoiceId
}

const main = async (): Promise<void> => {
  const service = await getGameServicePromise()
  console.log('─'.repeat(70))
  console.log(`  ส่งบอต ${count} คน เข้าห้อง ${roomCode}`)
  console.log(`  โหมด: ${service.isDemo ? 'DEMO (localStorage)' : 'FIREBASE จริง'}`)
  console.log('  บอตจะรอครูกดเปลี่ยนสเตจเอง ไม่สั่งเดินเกมแทนครู')
  console.log('─'.repeat(70))

  const uid = await service.ensureSession()

  // ── Join, staggered like people walking in ───────────────────────────────────────────────────
  const bots: Bot[] = []
  for (let index = 0; index < count; index += 1) {
    const studentNumber = String(startNumber + index).padStart(2, '0')
    try {
      const joined = await service.joinRoom(
        { roomCode, displayName: BOT_NAMES[index % BOT_NAMES.length], studentNumber },
        uid,
      )
      bots.push({
        index,
        player: joined.player,
        me: joined.player,
        roster: null,
        stopMe: null,
        stopRoster: null,
        accuracy: rand(0.45, 0.95),
        preDone: 0,
        postDone: 0,
        recallDone: new Set(),
        mainDone: new Set(),
        bossDone: new Set(),
        surveyDone: 0,
        votedFor: null,
        namedTeam: false,
        choseItem: false,
      })
      console.log(`  ✔ เข้าห้องแล้ว: ${joined.player.displayName} (เลขที่ ${studentNumber})`)
    } catch (error) {
      console.error(`  ✖ เข้าห้องไม่ได้ (เลขที่ ${studentNumber}): ${(error as Error).message}`)
      if ((error as Error).message.includes('ถูกใช้แล้ว')) {
        console.error('     เลขที่นี้มีผู้เล่นจากรอบก่อนค้างอยู่ — ใช้ห้องใหม่ หรือเพิ่ม --startNumber=11')
      }
    }
    await sleep(rand(250, 700))
  }

  if (bots.length === 0) {
    console.error('\n✖ ไม่มีบอตเข้าห้องได้เลย — ตรวจรหัสห้อง/สถานะห้องอีกครั้ง\n')
    process.exit(1)
  }
  console.log(`\n  เข้าห้องสำเร็จ ${bots.length} คน — รอครูเริ่มสเตจถัดไป...\n`)

  // ── Follow the room, react per phase ─────────────────────────────────────────────────────────
  let room: Room | null = null
  const stopRoom = service.subscribeRoom(roomCode, (value) => { room = value }, () => {})
  // NOT subscribePlayers: players/{id} is `allow list: if isTeacher(roomCode)`, so a student
  // listing the roster is permission-denied. Each bot watches its OWN player doc, exactly as the
  // student UI does, and reads teammates from the team roster (which IS broadly readable).
  bots.forEach((bot) => {
    bot.stopMe = service.subscribePlayer(roomCode, bot.player.id, (value) => {
      if (value) bot.me = value
    }, (message) => console.error(`  ⚠ อ่านข้อมูลผู้เล่นไม่ได้ (${bot.player.displayName}): ${message}`))
  })

  // Attach a roster watcher as soon as a bot learns which team it is on.
  const ensureRosterWatch = (bot: Bot): void => {
    const teamId = bot.me?.teamId
    if (!teamId || bot.stopRoster) return
    bot.stopRoster = service.subscribeTeamRoster(roomCode, teamId, (value) => {
      bot.roster = value
    }, (message) => console.error(`  ⚠ อ่านรายชื่อทีมไม่ได้: ${message}`))
  }

  const reported = new Set<string>()
  const report = (key: string, message: string): void => {
    if (reported.has(key)) return
    reported.add(key)
    console.error(`  ⚠ ${message}`)
  }

  let lastPhase = ''
  let busy = false

  const tick = async (): Promise<void> => {
    const current = room as Room | null
    if (!current || busy) return
    busy = true
    try {
      if (current.phase !== lastPhase) {
        lastPhase = current.phase
        console.log(`\n▶ สเตจ: ${current.phase}${current.status === 'completed' ? ' (จบรอบ)' : ''}`)
      }

      // Team setup: everyone votes, then the elected captain names the team and picks an item.
      if (current.phase === 'teamSetup' && current.teamsLocked) {
        bots.forEach(ensureRosterWatch)
        for (const bot of bots) {
          const me = bot.me
          if (!me?.teamId) continue
          const teammates = bot.roster?.members ?? []
          if (!bot.votedFor && teammates.length > 0) {
            const target = teammates[Math.floor(Math.random() * teammates.length)]
            try {
              await service.castCaptainVote(roomCode, bot.player.id, target.playerId)
              bot.votedFor = target.playerId
              console.log(`  🗳  ${me.displayName} โหวต ${target.displayName}`)
            } catch (error) {
              report(`vote:${bot.player.id}`, `โหวตไม่สำเร็จ (${me.displayName}): ${(error as Error).message}`)
            }
          }
        }
        // Captain duties. Only the elected captain may do these, so a rejection here is the
        // normal case for the other five bots — reported once, not spammed.
        for (const bot of bots) {
          const me = bot.me
          if (!me?.teamId) continue
          if (!bot.namedTeam) {
            try {
              await service.setTeamGuardianName(roomCode, me.teamId, bot.player.id, `ทีมบอท ${me.teamId.slice(-1)}`)
              bot.namedTeam = true
              console.log(`  🏷  ${me.displayName} ตั้งชื่อทีมแล้ว`)
            } catch { /* not the captain */ }
          }
          if (bot.namedTeam && !bot.choseItem) {
            const items = ['power_surge', 'score_seal', 'rose_shield', 'illusion'] as const
            try {
              await service.chooseStartingItem(roomCode, me.teamId, bot.player.id, items[bot.index % items.length])
              bot.choseItem = true
              console.log(`  🎁 ${me.displayName} เลือกไอเทมเริ่มต้นแล้ว`)
            } catch (error) {
              report(`item:${bot.player.id}`, `เลือกไอเทมไม่สำเร็จ: ${(error as Error).message}`)
            }
          }
        }
      }

      // Pre-test: self-paced, one item at a time.
      if (current.phase === 'preTest' && current.preTestStartedAt) {
        for (const bot of bots) {
          const me = bot.me
          const progress = me?.preTestProgress ?? bot.preDone
          if (progress >= PRE_TEST_QUESTIONS.length) continue
          const question = PRE_TEST_QUESTIONS[progress]
          await think()
          try {
            await service.savePreTestAnswer(roomCode, bot.player.id, {
              questionId: question.id,
              selectedChoiceId: pickChoice(question, bot.accuracy),
              expectedIndex: progress,
            })
            bot.preDone = progress + 1
          } catch { /* window closed or out of order */ }
        }
      }

      // Recall: room-synchronized — everyone answers the SAME live item.
      if (current.phase === 'recall' && current.recallQuestionStartedAt) {
        const index = current.recallQuestionIndex
        const question = RECALL_QUESTIONS[index]
        if (question) {
          for (const bot of bots) {
            if (bot.recallDone.has(question.id)) continue
            // A few students miss an item; that is realistic and the room must tolerate it.
            if (Math.random() < 0.08) { bot.recallDone.add(question.id); continue }
            await think()
            try {
              await service.saveRecallAnswer(roomCode, bot.player.id, {
                conceptId: question.id,
                selectedChoiceId: pickChoice(question, bot.accuracy),
                expectedRecallIndex: index,
              })
              bot.recallDone.add(question.id)
            } catch { /* timed out */ }
          }
        }
      }

      // Main: one shared question at a time.
      if (current.phase === 'main') {
        const questionId = current.questionIds[current.currentQuestionIndex]
        const question = questionId ? questionsById.get(questionId) : undefined
        if (question) {
          for (const bot of bots) {
            if (bot.mainDone.has(question.id)) continue
            await think()
            try {
              await service.saveAnswer(roomCode, bot.player.id, {
                questionId: question.id,
                selectedChoiceId: pickChoice(question, bot.accuracy),
                expectedQuestionIndex: current.currentQuestionIndex,
              })
              bot.mainDone.add(question.id)
            } catch { /* window closed */ }
          }
        }
      }

      // Boss: 3 rapid questions, first answer locked.
      if (current.phase === 'boss' && current.bossQuestionStartedAt) {
        const bossId = current.bossQuestionIds[current.bossQuestionIndex]
        const question = bossId ? bossQuestionsById.get(bossId) : undefined
        if (question) {
          for (const bot of bots) {
            if (bot.bossDone.has(question.id)) continue
            await sleep(rand(400, 1800))
            try {
              await service.saveBossAnswer(roomCode, bot.player.id, {
                questionId: question.id,
                selectedChoiceId: pickChoice(question, bot.accuracy),
                expectedBossIndex: current.bossQuestionIndex,
              })
              bot.bossDone.add(question.id)
            } catch { /* too late */ }
          }
        }
      }

      // Post-test.
      if (current.phase === 'postTest' && current.postTestStartedAt) {
        for (const bot of bots) {
          const me = bot.me
          const progress = me?.postTestProgress ?? bot.postDone
          if (progress >= POST_TEST_QUESTIONS.length) continue
          const question = POST_TEST_QUESTIONS[progress]
          await think()
          try {
            await service.savePostTestAnswer(roomCode, bot.player.id, {
              questionId: question.id,
              // Post-test runs after the lesson, so bots do a little better than before.
              selectedChoiceId: pickChoice(question, Math.min(0.97, bot.accuracy + 0.2)),
              expectedIndex: progress,
            })
            bot.postDone = progress + 1
          } catch { /* window closed */ }
        }
      }

      // Survey.
      if (current.phase === 'survey') {
        for (const bot of bots) {
          const me = bot.me
          const answered = me?.surveyResponses.length ?? bot.surveyDone
          if (answered >= SURVEY_ITEMS.length) continue
          const item = SURVEY_ITEMS[answered]
          await sleep(rand(400, 1200))
          try {
            const value = SURVEY_SCALE[Math.max(2, Math.floor(rand(2, SURVEY_SCALE.length)))].value
            await service.saveSurveyResponse(roomCode, bot.player.id, {
              itemId: item.id,
              value,
              expectedIndex: answered,
            })
            bot.surveyDone = answered + 1
          } catch { /* out of order */ }
        }
      }
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => { void tick() }, 1200)

  const shutdown = (): void => {
    clearInterval(timer)
    bots.forEach((bot) => { bot.stopRoster?.(); bot.stopMe?.() })
    stopRoom()
    console.log('\n  หยุดบอตแล้ว (ผู้เล่นยังอยู่ในห้อง)\n')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
