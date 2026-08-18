import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { GameProvider } from './context/GameContext'
import { ClosedPage } from './pages/ClosedPage'
import { CongratulationsPage } from './pages/CongratulationsPage'
import { GamePage } from './pages/GamePage'
import { HomePage } from './pages/HomePage'
import { JoinPage } from './pages/JoinPage'
import { LobbyPage } from './pages/LobbyPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ResultPage } from './pages/ResultPage'
import { TeacherHistoryPage } from './pages/TeacherHistoryPage'
import { TeacherPage } from './pages/TeacherPage'

const App = () => (
  <GameProvider>
    <BrowserRouter>
      <Routes>
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
      </Routes>
    </BrowserRouter>
  </GameProvider>
)

export default App
