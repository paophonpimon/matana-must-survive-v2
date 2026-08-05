# เอกสารส่งต่องาน — มัทนาต้องรอด

สรุปเมื่อ: **16 กรกฎาคม 2026 เวลา 02:04:49 น. (UTC+7 / Asia/Bangkok)**  
Commit: **ไม่มี Git metadata ใน workspace นี้ จึงไม่สามารถระบุ commit hash ได้**  
สถานะอ้างอิง: working directory ปัจจุบันหลังผ่าน lint, typecheck, tests และ production build ล่าสุด

> เอกสารนี้ระบุเฉพาะชื่อ environment variables และไม่มีค่าจาก `.env.local` หรือข้อมูลลับใด ๆ

## 1. ฟีเจอร์ที่ทำเสร็จแล้ว

- ครูสร้างห้องใหม่ รับรหัส 6 ตัว และเห็นรายชื่อกลุ่มแบบ realtime
- นักเรียนเข้าห้องด้วยรหัส ตั้งชื่อกลุ่ม/ผู้พิทักษ์ และป้องกันชื่อกลุ่มซ้ำแบบ trim + normalized
- ทุกกลุ่มใช้ `questionIds` ชุดเดียวกัน 10 ข้อ ลำดับเดียวกัน และสุ่มเพียงครั้งเดียวต่อรอบ
- ครูกำหนดเวลาต่อข้อได้ตั้งแต่ 5 วินาทีถึง 10 นาที ทุกกลุ่มใช้ deadline ระดับห้องเดียวกัน
- นักเรียนเปลี่ยนคำตอบได้จนหมดเวลา ระบบเก็บเพียงคำตอบล่าสุดและปรับคะแนนใหม่ทั้งกรณีผิด→ถูกและถูก→ผิด
- เมื่อหมดเวลา ตัวเลือกถูกล็อกและแสดงถูก/ผิด คะแนนสะสม และเฉลยเป็นเวลา 4 วินาทีก่อนเปลี่ยนข้อพร้อมกัน
- จอครูซ่อนคะแนนของข้อปัจจุบันระหว่างเวลาตอบ และเปิดคะแนน/จัดอันดับใหม่พร้อมช่วงเฉลยของนักเรียน
- ระหว่างเล่น จอครูเข้าสู่ broadcast mode: ย่อข้อมูลรอง ขยายกระดานคะแนน แสดงเวลา/ข้อ/จำนวนทีมที่ตอบ/คะแนนเฉลี่ย และเน้นทีมที่นำ
- มีตราโล่อันดับสีทอง เงิน ทองแดง และดาวสำหรับทีมที่นำ
- เมื่อจบรอบ จอครูแสดงเวทีอันดับ 1 ขนาดใหญ่ พร้อมเหรียญ แสงรัศมี พลุ และอันดับ 2–3; รองรับคะแนนอันดับหนึ่งเสมอกันและ `prefers-reduced-motion`
- จอนักเรียนแสดงเฉพาะคะแนนทีมตนเอง: 0–4 ล้มเหลว, 5–8 เกือบสำเร็จ, 9–10 สำเร็จ
- ครูเตรียมรอบใหม่ได้โดยเก็บรายชื่อกลุ่มเดิม และ reset คะแนน/คำตอบ/สถานะ
- มีปุ่ม “หยุดเกม” ฉุกเฉินตลอดช่วงเล่น เพื่อยกเลิกรอบที่ค้าง พาทุก client กลับ lobby เก็บรายชื่อเดิม และเตรียมชุดคำถามรอบใหม่
- Refresh recovery ครอบคลุม lobby, game, result และสถานะห้องปิดตาม session ที่เก็บใน browser
- รองรับ Demo Mode และ Firebase Mode ผ่าน `GameService` interface เดียวกัน
- ทุกภาพหลักใช้ PNG พร้อม gradient fallback, `object-fit: cover`, responsive layout และ reduced-motion handling

## 2. ไฟล์ที่แก้ล่าสุด

เนื่องจากไม่มี Git metadata รายการนี้สรุปจากชุดการเปลี่ยนแปลงล่าสุดใน workspace:

- `src/pages/TeacherPage.tsx` — broadcast scoreboard, คะแนนที่เปิดเผยตาม deadline, โล่อันดับ, เวทีอันดับ 1–3, พลุ และปุ่มหยุดฉุกเฉิน
- `src/pages/GamePage.tsx` — เปลี่ยนคำตอบได้จนหมดเวลาและ UI แสดงคำตอบล่าสุด
- `src/styles.css` — responsive scoreboard, broadcast mode, โล่ SVG, podium/fireworks และ reduced motion
- `src/lib/gameFlow.ts` — timer/reveal helpers, teacher-visible score และ answer locking
- `src/lib/gameFlow.test.ts` — tests ของ deadline, reveal, answer lock และการซ่อนคะแนนจอครู
- `src/services/gameService.ts` — contract ของ timed game และ `stopRound`
- `src/services/demoService.ts` — shared Demo state, timed flow, เปลี่ยนคำตอบ, reset และ emergency stop
- `src/services/firebaseService.ts` — Firestore transactions/listeners สำหรับ flow เดียวกับ Demo
- `src/services/demoService.test.ts` — behavioral tests ของ classroom flow, answer replacement และ stuck-round recovery
- `src/types/game.ts` — Room/Team/Answer data model ของ timed flow
- `src/components/Layout.tsx` — className support และส่วนประกอบ layout/fallback/accessibility
- `firestore.rules` — ownership, team update constraints และการแทนที่คำตอบก่อนหมดเวลา
- `vite.config.ts` — shared Demo state endpoint สำหรับ dev/preview
- `README.md` — วิธีติดตั้ง, Demo/Firebase, deployment, data model และข้อจำกัด
- `QA_REPORT.md` — รายงาน QA ภาษาไทยล่าสุด
- `scripts/load-test-40.mjs` — production load test สำหรับ 40 Anonymous Auth clients, realtime และ concurrent answers
- `LOAD_TEST_REPORT.md` — ผลทดสอบ production 40 clients และข้อจำกัด
- `package.json` — เพิ่มคำสั่ง `npm run loadtest:40`

## 3. บั๊กที่แก้แล้วและสาเหตุ

1. **ตอบข้อแรกแล้วค้าง ปุ่ม disabled ถาวร** — lifecycle/effect ใน development StrictMode เคยทำให้ mounted/timeout state ไม่กลับสภาพ แก้การ reset state, cleanup และการอ่าน progress จาก service/realtime
2. **ห้อง Demo ที่สร้างเองเข้าจาก browser context อื่นไม่ได้** — เดิมเก็บ state ใน localStorage ของแต่ละ context แยกกัน แก้ด้วย shared endpoint ใน Vite dev/preview และ polling พร้อม localStorage fallback
3. **ห้อง MATANA ค้างสถานะปิด** — state เก่าถูกเก็บใน localStorage แก้ด้วย reset flow ที่สร้างห้อง waiting พร้อมกลุ่มตัวอย่างใหม่
4. **เกมเดิมตัดสินจากความเร็ว** — ทีมที่ตอบเร็วได้เปรียบ แก้เป็น timer ระดับ room และ advance คำถามพร้อมกัน
5. **ทุกข้อเปลี่ยนทันทีเมื่อหมดเวลา** — นักเรียนไม่เห็นผลคำตอบ แก้ด้วย reveal window 4 วินาที
6. **จอครูเห็นคะแนนก่อนนักเรียน** — score ถูกบันทึกทันทีใน Team snapshot แก้ด้วย `getTeacherVisibleScore` ที่หักแต้มของข้อปัจจุบันระหว่างเวลาตอบและเปิดเมื่อ deadline ถึง
7. **จอครู auto-advance ค้างถ้า service สำเร็จแต่ snapshot ไม่เปลี่ยน** — in-flight key เดิมไม่ถูกปล่อย แก้ด้วย watchdog ให้ลองซ้ำหลัง 3 วินาที โดย service ยังตรวจ expected question index
8. **broadcast mode ไม่มีทางกู้รอบค้าง** — ปุ่มควบคุมถูกซ่อนทั้งหมด แก้ด้วยปุ่มหยุดเกมแบบ fixed และ `stopRound` ใน Demo/Firebase
9. **นักเรียนกดผิดแล้วแก้ไม่ได้** — service ปฏิเสธ question id ซ้ำ แก้เป็น replace answer record เดิมและปรับ score delta ก่อน deadline
10. **จอครูสรุปคะแนนเรียบและอ่านจากจอใหญ่ยาก** — เพิ่ม podium อันดับ 1–3, โล่, คะแนนขนาดใหญ่, พลุ และ responsive presentation
11. **คะแนน/choice รับค่าจาก client โดยตรงมากเกินไป** — service ไม่รับ `isCorrect` จาก UI แล้ว แต่คำนวณจาก question bank และปฏิเสธ choice id ที่ไม่มีจริง
12. **ข้อความไทย/ชื่อยาวล้น control** — เพิ่ม `min-width: 0`, wrapping และ responsive grid
13. **Confirm dialog ขาด description relation** — เพิ่ม `aria-describedby` และ semantic dialog states

รายละเอียดบั๊กครบทั้งหมดอยู่ใน `QA_REPORT.md`

## 4. บั๊กหรือข้อจำกัดที่ยังเหลือ

- Firebase Web config, Anonymous Auth, Firestore Rules และ Hosting ถูกเปิดใช้จริงแล้ว แต่ยังไม่ได้ทดสอบ classroom flow แบบ end-to-end หลายอุปกรณ์ จึงยังไม่ยืนยัน transaction retry, network recovery และ realtime ภายใต้โหลดจริง
- ตามข้อกำหนดล่าสุดไม่ได้ใช้ browser automation; responsive, refresh และ projection ใช้การตรวจโค้ด/tests/build เป็นหลัก ต้องตรวจภาพจริงบนอุปกรณ์
- ตัวเดินเวลา/เปลี่ยนข้อกลางยังทำงานจาก `TeacherPage` client หากแท็บครูถูกปิด เครื่อง sleep หรือ JavaScript ถูก throttle เกมจะไม่ advance จนหน้าครูกลับมาทำงาน; มี watchdog และปุ่มหยุดฉุกเฉิน แต่ยังไม่ใช่ server-side scheduler
- เวลา deadline และการตรวจคำตอบอยู่ใน web client/service ไม่ใช่ trusted backend จึงไม่เหมาะกับข้อสอบเดิมพันสูง
- Firestore rules จำกัด owner, fields, answer count และ score delta แต่ไม่สามารถพิสูจน์ correct answer/deadline จากข้อมูล trusted server ได้ครบถ้วน
- Anonymous Authentication ผูกสิทธิ์ครูกับ browser uid หากล้าง storage หรือเปลี่ยนเครื่องอาจเสียสิทธิ์ควบคุมห้องเดิม
- Demo shared endpoint มีเฉพาะ `npm run dev`/preview ผ่าน Vite; static hosting จะ fallback เป็น localStorage และไม่แชร์ state ข้ามอุปกรณ์จริง
- ภาพ PNG ประมาณ 2–3 MB ต่อไฟล์ อาจโหลดช้าบน Wi-Fi ห้องเรียนหรืออุปกรณ์เก่า
- คำถามปัจจุบันเป็นชุดตัวอย่าง 25 ข้อ ต้องให้ครูภาษาไทยตรวจความถูกต้องก่อนใช้ประเมินจริง
- Route `/congratulations/:roomCode` และ field `winner` ยังอยู่เพื่อ compatibility แต่ timed flow ปัจจุบันไม่ claim ผู้ชนะจากความเร็วและตั้ง `winner` เป็น `null`

## 5. สถานะ Demo Mode

สถานะ: **ใช้งานได้และมี automated behavioral tests**

- เปิดเป็นค่าเริ่มต้นด้วย `VITE_DEMO_MODE=true`
- ห้องตัวอย่าง `MATANA` มี 3 กลุ่มตัวอย่างและ reset ได้
- สร้างห้อง Demo ว่างใหม่จากหน้าครูได้
- dev/preview server แชร์ state ระหว่าง browser contexts ผ่าน Vite endpoint; มี localStorage fallback
- รองรับ create/join/start/timed answer/เปลี่ยนคำตอบ/reveal/advance/score/reset/stop/close
- tests ปัจจุบันครอบคลุม Demo flow รวมถึงชื่อซ้ำ ห้องหาย ห้องปิด deadline เปลี่ยนคำตอบ reset รายชื่อ และ emergency stop
- ไม่ควรใช้ Demo Mode เป็น multiplayer หลายเครื่องบน static hosting เพราะ state จะไม่แชร์ข้ามอุปกรณ์

## 6. สถานะ Firebase Mode

สถานะ: **Firebase Mode ออนไลน์แล้ว: Web config ถูกตั้งใน `.env.local`, Anonymous Auth เปิดใช้งาน, Rules compile/deploy ผ่าน และ Hosting เปิดสาธารณะที่ `https://matana-must-survive.web.app`**

- ใช้ Firebase Anonymous Authentication
- ใช้ Firestore `onSnapshot` สำหรับ room/team realtime listeners
- ใช้ transaction สำหรับ start/advance/save answer และ batch สำหรับ reset/stop/สถานะหลายทีม
- รองรับ answer replacement ก่อน deadline และ score delta -1/0/+1
- รองรับ emergency `stopRound` ให้ทุกทีมกลับ waiting โดยเก็บ team documents เดิม
- Firestore Rules เวอร์ชันล่าสุด deploy แล้วเมื่อ 16 กรกฎาคม 2026; compiler ผ่านโดยไม่มี warning หลังลบ helper ที่ไม่ถูกใช้งาน
- Hosting, `/teacher`, `/join` และภาพหลักตอบ HTTP 200 จาก URL production
- ยังต้องทดสอบ Emulator และหลายอุปกรณ์จริงก่อนใช้งานในชั้นเรียน

## 7. การเปลี่ยนแปลงโครงสร้าง Firestore

โครงสร้างปัจจุบัน:

```text
rooms/{roomCode}
  roomCode: string
  status: waiting | playing | completed | closed
  currentRound: number
  createdAt: timestamp/number
  startedAt: timestamp/number | null
  completedAt: timestamp/number | null
  currentQuestionIndex: number
  questionDurationSeconds: number
  questionStartedAt: timestamp/number | null
  questionIds: string[10]
  previousQuestionIds: string[]
  teacherSessionId: anonymous uid
  winner: null (legacy compatibility)

rooms/{roomCode}/teams/{teamId}
  teamName: string
  guardianName: string
  ownerUid: anonymous uid
  joinedAt: timestamp/number
  currentRound: number
  currentQuestionIndex: number
  score: number
  answers: AnswerRecord[]
  submitted: boolean
  finishedAt: timestamp/number | null
  elapsedMs: number | null
  status: waiting | playing | submitted | stopped

AnswerRecord
  questionId: string
  selectedChoiceId: string
  isCorrect: boolean
  answeredAt: timestamp/number
```

การเปลี่ยนแปลงสำคัญ:

- เพิ่ม `currentQuestionIndex`, `questionDurationSeconds` และ `questionStartedAt` ที่ room เพื่อให้ทุกทีมใช้คำถาม/deadline กลางเดียวกัน
- `questionIds` สุ่มครั้งเดียวต่อรอบและทุกทีมอ้างจาก room
- การเปลี่ยนคำตอบใช้การแทนที่ AnswerRecord ของ question เดิม ไม่ append record ซ้ำ
- score เปลี่ยนได้ -1/0/+1 ตามคำตอบล่าสุดก่อน deadline
- `stopRound` เพิ่ม `currentRound`, เลือกคำถามใหม่, reset team fields และคง team document/id เดิม
- rules อนุญาต student update เฉพาะ `answers` และ `score` ของทีมที่ตนเป็น owner ระหว่าง room `playing`; ครูแก้ room/teams ได้

## 8. Environment variables ที่ต้องใช้

ห้ามนำค่าจริงมา commit และให้สร้าง `.env.local` จาก `.env.example`:

```env
VITE_DEMO_MODE=<true หรือ false>
VITE_FIREBASE_API_KEY=<กำหนดในเครื่องหรือระบบ deploy>
VITE_FIREBASE_AUTH_DOMAIN=<กำหนดในเครื่องหรือระบบ deploy>
VITE_FIREBASE_PROJECT_ID=<กำหนดในเครื่องหรือระบบ deploy>
VITE_FIREBASE_STORAGE_BUCKET=<กำหนดในเครื่องหรือระบบ deploy>
VITE_FIREBASE_MESSAGING_SENDER_ID=<กำหนดในเครื่องหรือระบบ deploy>
VITE_FIREBASE_APP_ID=<กำหนดในเครื่องหรือระบบ deploy>
```

- Demo: ใช้ `VITE_DEMO_MODE=true`; Firebase variables ปล่อยว่างได้
- Firebase: ใช้ `VITE_DEMO_MODE=false` และกำหนด Firebase variables ทั้ง 6 ค่า
- ห้ามใส่ service-account key, Admin SDK credential หรือ server secret ใน Vite environment variables

## 9. ผลตรวจล่าสุด

ผลจากสถานะโค้ดล่าสุดก่อนสร้างไฟล์นี้:

| คำสั่ง | ผล |
| --- | --- |
| `npm run lint` | ผ่าน, exit code 0 |
| `npm run typecheck` | ผ่าน, exit code 0 |
| `npm run test` | ผ่าน 3/3 files, 22/22 tests |
| `npm run build` | ผ่าน, Vite build สำเร็จ 79 modules |
| Firebase Hosting deploy | ผ่าน, release production สำเร็จ |
| Firestore Rules deploy | ผ่าน, compile/release สำเร็จโดยไม่มี warning |
| Production load test | ผ่าน 40/40 clients, 0 auth/join/realtime/transaction errors; ดู `LOAD_TEST_REPORT.md` |

Production output ล่าสุดอยู่ใน `dist/`  
หมายเหตุ: เครื่องที่สร้างรายงานไม่มี npm global จึงเรียก npm 11.4.2 ผ่าน runtime package runner แต่ scripts ที่ทำงานจริงเป็นสี่คำสั่งด้านบน

## 10. ขั้นตอนรันโปรเจกต์

ต้องใช้ Node.js 20.19+ หรือ 22.12+ และ npm:

```bash
npm install
copy .env.example .env.local
npm run dev
```

macOS/Linux ใช้:

```bash
cp .env.example .env.local
```

จากนั้น:

1. Demo Mode: ตั้ง `VITE_DEMO_MODE=true`
2. เปิด URL ที่ Vite แสดง
3. ครูเปิด `/teacher`
4. นักเรียนเปิด `/join`
5. ห้องตัวอย่างใช้รหัส `MATANA` หรือให้ครูสร้างห้องใหม่

ตรวจ production:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Firebase Hosting ใช้ `dist/` และ SPA rewrite ใน `firebase.json`; Vercel ใช้ rewrite ใน `vercel.json`

## 11. ขั้นตอนที่ต้องทำต่อ

1. รัน Firebase Emulator tests สำหรับ `firestore.rules` โดยเฉพาะ join, answer append, answer replacement, late update, wrong owner และ teacher reset/stop
2. ทดสอบ Firebase Mode ด้วยครู 1 เครื่องและนักเรียนอย่างน้อย 3 เครื่องบน Wi-Fi เดียวกับห้องเรียน
3. ทดสอบเปลี่ยนคำตอบผิด→ถูกและถูก→ผิดก่อน deadline แล้วลองเปลี่ยนหลัง deadline
4. ทดสอบ refresh ที่ waiting, playing, reveal และ result บนอุปกรณ์จริง
5. ทดสอบปุ่มหยุดเกมระหว่างรอบและยืนยันทุกเครื่องกลับ lobby โดยรายชื่อยังอยู่
6. สะท้อน iPad/แท็บเล็ตขึ้นจอ 50 นิ้ว ตรวจ broadcast scoreboard, ชื่อยาว, podium และอันดับเสมอ
7. ทดสอบ network drop/reconnect, browser sleep/background throttling และเครื่องครูล็อกหน้าจอ
8. ให้ครูภาษาไทยตรวจคำถาม/ตัวเลือก/correctChoiceId ทั้งหมด
9. พิจารณาย้าย timer/scoring ไป Cloud Functions หรือ backend หากต้องการความน่าเชื่อถือระดับการสอบจริง

## 12. จุดเสี่ยงก่อนใช้กับนักเรียนจริง

- **ความเสี่ยงสูง:** production synthetic load test ผ่าน 40/40 SDK clients แล้ว แต่ยังไม่เคยทดสอบมือถือจริงพร้อมกันหลายอุปกรณ์บน Wi-Fi โรงเรียน
- **ความเสี่ยงสูง:** timer advance พึ่งหน้า Teacher เปิดทำงานอยู่ ควรปิด sleep/auto-lock และเสียบไฟเครื่องครู
- **ความเสี่ยงสูง:** scoring และคำตอบที่ถูกอยู่ใน client bundle ผู้ใช้ที่มีทักษะสามารถดูหรือดัดแปลงได้
- **ความเสี่ยงกลาง:** ต้องทดสอบ rule paths จริงทุกกรณี โดยเฉพาะการแก้คำตอบและ emergency stop เพื่อจับ permission-denied ที่ automated tests ฝั่ง Demo ไม่ครอบคลุม
- **ความเสี่ยงกลาง:** Anonymous uid ของครูอาจหายเมื่อ clear browser data; ห้ามเปลี่ยน browser/profile กลางคาบ
- **ความเสี่ยงกลาง:** Wi-Fi ห้องเรียนอาจทำให้ snapshot/transaction ช้า ต้องมี Demo/แผนสำรองและทดสอบโหลดพร้อมกันจริง
- **ความเสี่ยงกลาง:** PNG ขนาดใหญ่ทำให้ first load ช้าบนมือถือหรือเครือข่ายอ่อน
- **ความเสี่ยงกลาง:** ยังไม่ได้ visual QA ผ่าน browser automation ตามข้อกำหนดผู้ใช้ ต้องตรวจ 360px, 390px, 768px และจอฉายจริงด้วยมือ
- **ความเสี่ยงเนื้อหา:** คำถามยังเป็นตัวอย่าง ต้องตรวจโดยผู้สอนก่อนนำคะแนนไปใช้
- ก่อนคาบควรรีสตาร์ต server/เปิดห้องใหม่ ทดสอบเข้าร่วมหนึ่งทีม เล่นอย่างน้อยหนึ่งข้อ ทดสอบ reveal และปุ่มหยุดเกม แล้วจึงแจก room code

## 13. Commit หรือเวลาที่สรุป

- เวลา: **2026-07-16 02:04:49 +07:00 (Asia/Bangkok)**
- Commit: **ไม่มีข้อมูล** — workspace นี้ไม่มี `.git`/Git metadata จึงไม่สามารถอ้าง commit hash ได้
- ผู้ตรวจคนถัดไปควรสร้าง Git repository หรือ commit checkpoint ก่อนแก้ต่อ เพื่อให้ตรวจ diff และย้อนกลับได้อย่างปลอดภัย
