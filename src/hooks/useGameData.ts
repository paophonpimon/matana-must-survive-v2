import { useEffect, useState } from 'react'
import { useGame } from '../context/GameContext'
import type { AnswerProgressEntry, MagicEvent, Player, Room, TeamMagicState, TeamRosterSummary } from '../types/game'

interface Loadable<T> {
  data: T
  loading: boolean
  error: string
}

export const useRoom = (roomCode: string): Loadable<Room | null> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Room | null>>({ data: null, loading: true, error: '' })

  useEffect(() => {
    if (!roomCode) {
      setState({ data: null, loading: false, error: '' })
      return
    }
    setState({ data: null, loading: true, error: '' })
    return service.subscribeRoom(
      roomCode,
      (room) => setState({ data: room, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service])

  return state
}

export const usePlayers = (roomCode: string): Loadable<Player[]> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Player[]>>({ data: [], loading: true, error: '' })

  useEffect(() => {
    if (!roomCode) {
      setState({ data: [], loading: false, error: '' })
      return
    }
    setState({ data: [], loading: true, error: '' })
    return service.subscribePlayers(
      roomCode,
      (players) => setState({ data: players, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service])

  return state
}

export const usePlayer = (roomCode: string, playerId: string): Loadable<Player | null> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Player | null>>({ data: null, loading: true, error: '' })

  useEffect(() => {
    if (!roomCode || !playerId) {
      setState({ data: null, loading: false, error: '' })
      return
    }
    setState({ data: null, loading: true, error: '' })
    return service.subscribePlayer(
      roomCode,
      playerId,
      (player) => setState({ data: player, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service, playerId])

  return state
}

export const useTeamMagic = (roomCode: string, teamId: string): Loadable<TeamMagicState | null> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<TeamMagicState | null>>({ data: null, loading: true, error: '' })

  useEffect(() => {
    if (!roomCode || !teamId) {
      setState({ data: null, loading: false, error: '' })
      return
    }
    setState({ data: null, loading: true, error: '' })
    return service.subscribeTeamMagic(
      roomCode,
      teamId,
      (magic) => setState({ data: magic, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service, teamId])

  return state
}

export const useAllTeamMagic = (roomCode: string): Loadable<TeamMagicState[]> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<TeamMagicState[]>>({ data: [], loading: true, error: '' })

  useEffect(() => {
    if (!roomCode) {
      setState({ data: [], loading: false, error: '' })
      return
    }
    setState({ data: [], loading: true, error: '' })
    return service.subscribeAllTeamMagic(
      roomCode,
      (magic) => setState({ data: magic, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service])

  return state
}

export const useMagicEvents = (roomCode: string): Loadable<MagicEvent[]> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<MagicEvent[]>>({ data: [], loading: true, error: '' })

  useEffect(() => {
    if (!roomCode) {
      setState({ data: [], loading: false, error: '' })
      return
    }
    setState({ data: [], loading: true, error: '' })
    return service.subscribeMagicEvents(
      roomCode,
      (events) => setState({ data: events, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service])

  return state
}

export const useTeamRoster = (roomCode: string, teamId: string): Loadable<TeamRosterSummary | null> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<TeamRosterSummary | null>>({ data: null, loading: true, error: '' })

  useEffect(() => {
    if (!roomCode || !teamId) {
      setState({ data: null, loading: false, error: '' })
      return
    }
    setState({ data: null, loading: true, error: '' })
    return service.subscribeTeamRoster(
      roomCode,
      teamId,
      (roster) => setState({ data: roster, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service, teamId])

  return state
}

export const useTeamAnswerProgress = (roomCode: string, teamId: string): Loadable<AnswerProgressEntry[]> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<AnswerProgressEntry[]>>({ data: [], loading: true, error: '' })

  useEffect(() => {
    if (!roomCode || !teamId) {
      setState({ data: [], loading: false, error: '' })
      return
    }
    setState({ data: [], loading: true, error: '' })
    return service.subscribeTeamAnswerProgress(
      roomCode,
      teamId,
      (entries) => setState({ data: entries, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service, teamId])

  return state
}
