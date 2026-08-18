# Matana Must Survive — UX/UI System Handoff

> **THIS FILE REPLACES ecc2b68 AS THE UX/UI SYSTEM BASELINE.**
>
> Everything below describes the **currently implemented** system. Anything not implemented is
> absent from this document. Items implemented but **not yet smoke-tested on real Firebase** are
> marked ⚠️.

Thai classroom game (React 19 + TypeScript + Vite + Tailwind v4 + Firebase Firestore).
Two backends behind one `GameService` interface: `FirebaseGameService` (production) and
`DemoGameService` (local/demo). Every capability exists in both.

---

## 1. Canonical flow — LOCKED

```
Pre-test 10 → Recall 5 → Team Setup → Main Q1–5 → Boss 3 → Main Q6–10 → Post-test 10 → Survey 6 → Result
```

`room.phase` is the single source of truth:
`lobby | preTest | recall | teamSetup | main | boss | postTest | survey`

`room.status` is orthogonal: `waiting` spans lobby/preTest/recall/teamSetup; `playing` spans
main/boss/postTest/survey; then `completed`, or `closed`.

**Counts are locked: 10 / 5 / 10 / 3 / 10 / 6.** Do not redesign around different counts.

---

## 2. Screens

### Student (`/game/:code`, `/lobby/:code`, `/result/:code`)
One router decides the screen: `resolveStudentRoute(room, player)`. All three student pages defer
to it — they cannot disagree.

Precedence: `closed` → `winner` → `completed` → `preTest` → `recall` → `postTest` → `survey` →
`waiting`→lobby → `submitted`→result → game.

| Phase | Student sees |
|---|---|
| lobby | waiting lobby, room code |
| preTest | waiting screen **or** one question at a time + timer |
| recall | one shared question, synchronized countdown |
| teamSetup | lobby: captain vote, team name (captain), starting item (captain) |
| main | question card, 4 choices, team item panel |
| boss | 3 rapid questions; then a boss-result waiting screen |
| postTest | waiting screen **or** one question at a time + timer |
| survey | 6 opinion items, 1–5 scale |
| result | own knowledge score, recall result, own pre/post |

### Teacher (`/teacher`)
Stage screens are **single-viewport**: during `lobby`, `preTest`, `recall`, `postTest`, `survey`
the full dashboard body is hidden so the stage CTA is never below the fold. The dashboard returns
at `teamSetup` and during `main`/`boss`.

Also `/teacher/history` — read-only room history (§13).

---

## 3. Pre/Post gating — LOCKED

Reaching a stage is **not** the same as opening the test.

- `phase === 'preTest' | 'postTest'` → the room is *at* the stage
- `room.preTestStartedAt` / `room.postTestStartedAt` non-null → the test is **open**

Main Q10 moves the room to `postTest` with `postTestStartedAt: null`. Students wait; the teacher
must press **“เริ่มแบบทดสอบหลังเรียน”**. Writes are rejected server-side while closed
(`ผู้ใช้:ครูยังไม่ได้เริ่มแบบทดสอบหลังเรียน`), so no client can slip past. Same for the pre-test.

`player.submitted` is **never** the assessment gate. Do not reintroduce it.

Teacher assessment stage shows: per-question time, completed X / total, and per-student status —
**ยังไม่เริ่ม / กำลังทำ / เสร็จแล้ว / หมดเวลา**. Counts only; no answer content ever reaches the
projected screen. The continue button is never gated on everyone finishing — one student must never
hold the class. If anyone is unfinished, a confirmation states the real consequence (those students
leave the pre/post comparison).

---

## 4. Pre/Post timer — per question

One shared setting for both tests: `room.assessmentSecondsPerQuestion`, default **30 s**, range
**10–120 s**.

Each question's window is *derived*, never stored:
- question 1 → the instant the teacher opened the test (+ phase-intro offset)
- question N → `answeredAt` of question N−1

So answering resets the countdown to the full value, and refresh/reconnect recompute the same
deadline. Student sees remaining time plus a warning in the final 30 s. Not competitive: no speed
score, no bonus, no answer reveal.

**At timeout:** that question locks, saved answers are kept, unanswered items stay unanswered,
nothing is fabricated.

⚠️ **Known consequence, needs a product decision:** because a student's question index *is* their
answer count, a timed-out question currently ends that student's test — they cannot advance past
it. Evidence handles them correctly (excluded from the paired comparison, never scored 0), but
recovering would need an auto-advance/skip record. Not implemented.

---

## 5. Recall timing

Per item: `room.recallQuestionDurationSeconds`, default 15 s, range **5–120 s**. Room-synchronized
— everyone sees the same item at the same time. Post-question pause is **~1 s** (Main keeps 4 s).

---

## 6. Settings controls

Both timing settings live on the **lobby** stage, before anything starts — never on an assessment
screen, where a per-item control was mistaken for the test's own clock.

- `เวลาต่อข้อ (ก่อนเรียน/หลังเรียน)`
- `เวลาต่อข้อ (ทบทวนเรื่องราว)`

**One shared stepper** (`NumberStepper`) for every numeric setting: assessment, recall, main
question duration, boss duration, team count (×2). Structure is strictly `[ − ] [ value ] [ + ]` —
**no unit chip inside the control**; the unit is stated by the label and helper.

Steps by exactly **1**. Raised crimson caps + warm cream field (the Team Setup visual language,
extended app-wide): hover lift, press `translateY(2px)` with collapsing shadow, spring-back on
release, and a ~160 ms scale bump on the number when the value changes. Manual typing still works
and clamps on blur. `prefers-reduced-motion` drops all motion.

---

## 7. Team setup, captain, items

- Teacher randomizes teams → locks teams
- Team members vote a captain; teacher finalizes → `magicHolderPlayerId`
- Captain names the team (guardian name) and picks **one starting item**
- Start is gated on: teams locked, every team has a captain, a name, and a starting item

**Left roster cards** group students by team after lock and show: team name, member count, student
names, student numbers, and the captain as `👑 Name (หัวหน้าทีม)` — read from the persisted
`magicHolderPlayerId`, never from list order. Up to 12 team colour tones.

**Item secrecy — LOCKED.** The teacher/team-setup screen is projected, so it shows only readiness
(`เลือกไอเท็มแล้ว ✓`), **never which item**. Derived from a boolean over the whole inventory, so
there is no item type present to leak. The item is revealed normally only when the team activates
it during play.

The per-team admin block (name override, name reset, captain-election reset) was removed from the
Team Setup screen; it still exists on the dashboard. No capability was removed.

---

## 8. Main & Boss

Main: 10 questions, synchronized timer, 4 choices, ~4 s reveal, then everyone advances together.
Individual knowledge score is raw /10 — magic never touches it.

Boss (`ศึกชิงมนตรา`): 3 rapid questions after Main Q5. Boss answers live in a separate array and
**never** affect the knowledge score. After the 3rd, the phase pauses (`bossAwaitingContinue`)
until the teacher presses **เล่นต่อ**; then Main resumes at Q6. Winner earns one extra item.

**Items:** power_surge (×2 own), score_seal (halve a target), rose_shield (auto-block), illusion
(hide one wrong choice). Activation targets the **next** question; Q1 and the final question are
never eligible, so items are usable on Q1–Q8. Boss itself is item-disabled by design.

---

## 9. Student landscape layout

Target: **1180×800 / 1280×800 landscape tablet**, one viewport, no page scroll.

Two columns at `min-width: 1024px and (orientation: landscape)`:
- **left** — identity/progress/timer, question, 4 answers, answer state
- **right** — team item panel, effect, target, activation

Each column scrolls internally rather than the page. Below the breakpoint it collapses to the
original single column (phones and portrait tablets unchanged). Under 900 px height the vertical
rhythm compresses and long helper paragraphs hide; touch targets and font sizes are untouched.

Non-captains get a compact read-only line; captains get full controls without scrolling.

⚠️ Verified by computed style (2 columns at 1180×800, 1 at 375×812), **not yet by eye in a live
game**.

---

## 10. Target-team modal

The native `<select>` is gone. A full-width **“เลือกทีมเป้าหมาย”** button opens a modal titled the
same, showing every eligible team as a ≥4 rem card. On selection: modal closes, the target shows as
`🎯 เป้าหมาย: <team>` with “แตะเพื่อเปลี่ยนได้ก่อนใช้ไอเทม”. Target stays changeable until
activation. Escape and backdrop close it. Targeting rules unchanged.

---

## 11. Score Seal presentation

Rendered as an **in-flow banner at the top of the question card** — normal layout, full content
width, no absolute positioning, no negative margin, no transform. (The old corner badge hung
outside the card and clipped.)

Exactly two lines, shown once:
- `🔒 คะแนนข้อนี้เหลือ 50%`
- `ตอบถูกข้อนี้ ได้สูงสุด 5 คะแนน จากปกติ 10 คะแนน`

Never show standalone `50%` / `เหลือ 50%` / `50% ถูกผนึก`. Two stacked seals leave a **quarter**,
so the copy must not claim “half” there. Copy only — the multiplier math is untouched.

Surge and illusion keep their compact corner badges.

---

## 12. Per-student choice shuffling — LOCKED

Answer choice **order** is shuffled per student to reduce copying. Applies to Pre-test, Recall,
Main, Boss and Post-test. **Not** the survey. Question order is never shuffled.

Order is *derived*, never stored: a seeded shuffle of `(playerId, questionId)`. Same student, same
question → same order on every render, refresh, reconnect and device. Different students differ.

Correctness rides on `choiceId` everywhere; the ก/ข/ค/ง letters come from the render index and are
a per-student label only — never persisted, exported or compared across students. Illusion removes
a choice **by id before ordering**, so all teammates lose the same choice.

**UX consequence:** two students discussing “ข้อ ก” are no longer talking about the same choice.
Reports must never use visual letters. Boss *swipe* questions keep their authored order, because
left/right are bound to specific choice ids.

---

## 13. Phase intro transitions

A short CSS-only cutscene on entry to a major activity — never between ordinary questions.
Dark wash + vignette + two fading lines, **1.8 s**, no artwork or audio (real artwork comes later).

Copy per phase (eyebrow / title): preTest, recall, teamSetup, main, boss, postTest, survey, result.

Shown once per real phase entry (`roomCode-round-phase` in sessionStorage, marked before the
animation starts so a mid-intro reload cannot replay it).

**Timers lose nothing.** `PHASE_INTRO_MILLISECONDS` is applied as a read-side offset:
`deadline = persistedStart + introOffset + duration`. The persisted timestamp stays the real
server-authored instant (`serverTimestamp()` on Firebase) — **no client clock is ever the stored
authority**. Displayed remaining time is clamped to the configured duration, so during the intro it
shows the full time and does not decrement.

---

## 14. Teacher live board & Boss board

Main phase: room bar, live stats, leader spotlight, scoreboard.

Boss phase renders a dedicated **BossBoard** instead of the generic stat strip:
- Hero: `ศึกชิงมนตรา`, `3 ข้อพิเศษ • ชิงไอเท็ม • คะแนนพลิกเกมได้`, pulsing `● ช่วงพิเศษ`
- Summary strip: question N/3, oversized timer, answered/total, reward note
- Team cards with 7 states: `waiting, answered, correct, wrong, leading, tied, winner`
- Urgent timer under 3 s, `หมดเวลา` emphasis, outcome headline
  (`2 ทีมคะแนนเท่ากัน` / `ทีม X นำอยู่` / `ทีม X ชนะศึกชิงมนตรา`)
- Dark crimson/gold treatment, breathing aura; only transform/opacity/shadow animate

**LOCKED:** correctness is shown **only after the answer window closes**. While the timer runs a
team reads as `waiting` or `answered` only — this screen is projected, and live correctness would
tell the room the answer.

⚠️ Not yet seen rendered in a live game.

---

## 15. Learning evidence — LOCKED semantics

- **Recall is “ทบทวน” (review) only.** Never a pre-test, never a baseline. Recall vs Main must
  **never** be presented as learning gain.
- The **pre-test is the only baseline**; pre/post is the only before/after comparison.
- Paired pre/post includes **only students who completed all 10 items in BOTH tests**. Incomplete
  and timed-out students stay visible but read `-` / null — **never a fabricated 0**.
- Main is reported as raw /10 (magic never applied). Recall is reported separately as /5.
- Survey averages use **completed surveys only**.
- No t-test, no significance claims, no causal language. Approved phrasing is descriptive
  (“คะแนนหลังเรียนสูงกว่าก่อนเรียน”), never “ระบบทำให้ผลสัมฤทธิ์เพิ่มขึ้น”.

One shared aggregation (`computeEvidenceSummaryFromSources`) feeds the on-screen panel, the
printout and the workbook, so they cannot drift. Correctness is derived from the approved banks at
read time — never stored on a record.

---

## 16. Room history (`/teacher/history`)

CTA **“ประวัติห้อง”**, reachable with no active room (the usual case: printing a class from days
ago).

- Room list shows **room code, created date/time, status** only — one Firestore query over owned
  rooms, no history read per room
- Ownership: query constrained to `teacherSessionId == uid`, and the Firestore `list` rule rejects
  any query not so constrained
- Opening a room loads its round history **once**; that single load feeds round count, student
  count, available rounds, evidence, print and both exports
- Rounds newest first; read-only — nothing here can resume or mutate a room

### Print / PDF
**“พิมพ์รายงาน / PDF”** prints the selected room + selected round: room code, round, date, class
evidence, per-student rows, per-question ✓/✕/–. Column order and team names come from the
snapshot, not the live room. Cannot print the active room by accident.

### Excel
- **“ส่งออก Excel รอบนี้”** — selected round only
- **“ส่งออก Excel ทุกรอบ”** — every recorded round, each exactly once

Same six-sheet workbook and same formulas either way; only the input set is scoped.

**Legacy rounds** (recorded before the assessment layer) still open, print and export — missing
data reads `-`, never a fabricated zero.

---

## 17. Do not redesign away

1. Canonical flow and counts (10/5/10/3/10/6)
2. Pre/Post open only on explicit teacher action; `submitted` is not the gate
3. Recall is review, never a baseline; no Recall-vs-Main gain
4. Paired pre/post = completed-both only; incomplete shows `-`, never 0
5. Item secrecy on the projected team-setup screen
6. Boss correctness hidden until the answer window closes
7. Choice order is per student; reports must never rely on ก/ข/ค/ง
8. Assessment/Main/Boss timers derive from server-authored timestamps; no client clock authority
9. One unfinished student never blocks the class
10. Teacher screens are projected — never render answer content or live correctness on them
11. One shared stepper, ±1, no unit chip inside the control
12. No t-test / significance / causal claims in evidence wording

---

## 18. Status

- Full test suite: **304 passing**, 22 files. Typecheck, lint, build clean.
- Firestore rules deployed (project `matana-survive`), including the room-history `get`/`list` split.
- ⚠️ Not yet smoke-tested on real Firebase: per-question assessment timer, phase intros, landscape
  two-column layout, target modal, BossBoard, room history print/export.
- Hosting not deployed from this branch.
