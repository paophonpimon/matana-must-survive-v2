import type { ReactNode } from 'react'
import { BrowserRouter, Outlet, Route, Routes } from 'react-router-dom'
import { GameProvider } from './context/GameContext'
import { ClosedPage } from './pages/ClosedPage'
import { CongratulationsPage } from './pages/CongratulationsPage'
import { DemoStudentPage } from './pages/DemoStudentPage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { JoinPage } from './pages/JoinPage'
import { LobbyPage } from './pages/LobbyPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ResultPage } from './pages/ResultPage'
import { TeacherHistoryPage } from './pages/TeacherHistoryPage'
import { TeacherPage } from './pages/TeacherPage'
import { presentationDemoServicePromise } from './services'

const ProductionGameScope = () => <GameProvider><Outlet /></GameProvider>

// Both presentation surfaces share ONE injected local demo service (presentationDemoServicePromise),
// so /demo/teacher and /demo/student read and write the exact same demo state and never touch
// Firebase — the service is never selected by an env flag and never imports firebaseService.
const PresentationDemoScope = ({ children }: { children: ReactNode }) => (
  <div className="presentation-demo-route">
    <div className="presentation-demo-banner" role="status">โหมดสาธิต — ข้อมูลจำลอง</div>
    <GameProvider servicePromise={presentationDemoServicePromise}>
      {children}
    </GameProvider>
  </div>
)

const App = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/demo/teacher" element={<PresentationDemoScope><TeacherPage /></PresentationDemoScope>} />
      <Route path="/demo/student" element={<PresentationDemoScope><DemoStudentPage /></PresentationDemoScope>} />
      <Route element={<ProductionGameScope />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/teacher" element={<TeacherPage />} />
        {/* Read-only archive. Reachable without an active room, which is the point: a teacher
            comes back days later to print or export a past class. */}
        <Route path="/teacher/history" element={<TeacherHistoryPage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/lobby/:roomCode" element={<LobbyPage />} />
        <Route path="/game/:roomCode" element={<GamePage />} />
        <Route path="/result/:roomCode" element={<ResultPage />} />
        <Route path="/congratulations/:roomCode" element={<CongratulationsPage />} />
        <Route path="/closed/:roomCode" element={<ClosedPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  </BrowserRouter>
)

export default App
