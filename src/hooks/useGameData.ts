import { useEffect, useState } from 'react'
import { useGame } from '../context/GameContext'
import type { Room, Team } from '../types/game'

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

export const useTeams = (roomCode: string): Loadable<Team[]> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Team[]>>({ data: [], loading: true, error: '' })

  useEffect(() => {
    if (!roomCode) {
      setState({ data: [], loading: false, error: '' })
      return
    }
    setState({ data: [], loading: true, error: '' })
    return service.subscribeTeams(
      roomCode,
      (teams) => setState({ data: teams, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service])

  return state
}

export const useTeam = (roomCode: string, teamId: string): Loadable<Team | null> => {
  const { service } = useGame()
  const [state, setState] = useState<Loadable<Team | null>>({ data: null, loading: true, error: '' })

  useEffect(() => {
    if (!roomCode || !teamId) {
      setState({ data: null, loading: false, error: '' })
      return
    }
    setState({ data: null, loading: true, error: '' })
    return service.subscribeTeam(
      roomCode,
      teamId,
      (team) => setState({ data: team, loading: false, error: '' }),
      (error) => setState((current) => ({ ...current, loading: false, error })),
    )
  }, [roomCode, service, teamId])

  return state
}
