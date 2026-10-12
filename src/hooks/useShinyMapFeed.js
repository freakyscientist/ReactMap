// @ts-check

import * as React from 'react'

import { useMemory } from '@store/useMemory'

const POLL_INTERVAL_MS = 5000

export const useShinyMapFeed = () => {
  const loggedIn = useMemory((s) => s.auth.loggedIn)
  const discordId = useMemory((s) => s.auth.discordId)
  const telegramId = useMemory((s) => s.auth.telegramId)

  React.useEffect(() => {
    let stopped = false
    useMemory.setState({ userShinyEncounterIds: new Set(), userShinies: [] })

    if (!loggedIn) {
      return () => {
        stopped = true
      }
    }

    const update = async () => {
      const response = await fetch('/api/shiny-map')
      if (!response.ok) {
        throw new Error(`shiny map feed returned HTTP ${response.status}`)
      }

      const payload = await response.json()
      if (
        !payload ||
        !Array.isArray(payload.shinies) ||
        payload.shinies.some(
          (sighting) =>
            typeof sighting.encounterId !== 'string' ||
            !Number.isInteger(sighting.pokemonId) ||
            !Number.isFinite(sighting.latitude) ||
            !Number.isFinite(sighting.longitude) ||
            !Number.isInteger(sighting.despawnSec),
        )
      ) {
        throw new Error('shiny map feed response is invalid')
      }

      if (!stopped) {
        useMemory.setState({
          userShinies: payload.shinies,
          userShinyEncounterIds: new Set(
            payload.shinies.map((sighting) => sighting.encounterId),
          ),
        })
      }
    }

    const refresh = () => {
      update().catch((error) => {
        if (!stopped) {
          console.error('Failed to refresh the user shiny map feed', error)
        }
      })
    }

    refresh()
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [discordId, loggedIn, telegramId])
}
