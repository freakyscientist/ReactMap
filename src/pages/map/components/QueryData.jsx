// @ts-check
import * as React from 'react'
import { useQuery } from '@apollo/client'
import { useMap } from 'react-leaflet'

import { useMemory } from '@store/useMemory'
import { useStorage } from '@store/useStorage'
import { Query } from '@services/queries'
import { getQueryArgs } from '@utils/getQueryArgs'
import { RobustTimeout } from '@services/apollo/RobustTimeout'
import { FILTER_SKIP_LIST } from '@assets/constants'
import { Notification } from '@components/Notification'
import { GenerateCells } from '@features/s2cell'
import { RouteLayer } from '@features/route'
import { ActiveWeather } from '@features/weather'
import { useAnalytics } from '@hooks/useAnalytics'
import { useProcessError } from '@hooks/useProcessError'
import { normalizeCategory } from '@utils/normalizeCategory'

import { Clustering } from './Clustering'
import { TILES } from '../tileObject'
import { usePermCheck } from '../hooks/usePermCheck'

/** @param {string} category */
const userSettingsCategory = (category) => {
  switch (category) {
    case 'devices':
    case 'spawnpoints':
    case 'scanCells':
      return 'admin'
    case 'submissionCells':
    case 'portals':
      return 'wayfarer'
    default:
      return category
  }
}

const MANUAL_ID_CATEGORIES = new Set([
  'gyms',
  'pokestops',
  'pokemon',
  'nests',
  'portals',
  'stations',
  'routes',
  'tappables',
])

const POKEMON_RANGE_DEFAULTS = {
  iv: [0, 100],
  atk_iv: [0, 15],
  def_iv: [0, 15],
  sta_iv: [0, 15],
  cp: [10, 5000],
  level: [1, 55],
}

/**
 * Match feed-only sightings against the active numeric ranges in the Pokémon menu.
 * @param {Record<string, any>} sighting
 * @param {Record<string, any> | undefined} pokemonFilters
 */
const matchesShinyFilters = (sighting, pokemonFilters) => {
  const ranges = pokemonFilters?.ivOr || {}
  return Object.entries(POKEMON_RANGE_DEFAULTS).every(([field, defaults]) => {
    const range = ranges[field]
    if (!Array.isArray(range)) return true
    const isDefault = range[0] === defaults[0] && range[1] === defaults[1]
    if (isDefault) return true

    const value = sighting[field]
    return typeof value === 'number' && value >= range[0] && value <= range[1]
  })
}

/**
 * @param {Record<string, any>} sighting
 * @param {Record<string, any> | undefined} pokemonFilters
 */
const matchesQuickIvFilter = (sighting, pokemonFilters) =>
  (pokemonFilters?.hundoIv && sighting.iv === 100) ||
  (pokemonFilters?.zeroIv && sighting.iv === 0)

/** @param {Record<string, { rank?: number | null }[]> | null | undefined} pvp */
const getBestPvpRank = (pvp) =>
  Object.values(pvp || {})
    .flat()
    .reduce((best, entry) => {
      const rank = entry?.rank
      return typeof rank === 'number' && Number.isFinite(rank)
        ? Math.min(best, rank)
        : best
    }, 4096)

/**
 * @template {keyof import('@rm/types').AllFilters} T
 * @param {import('@rm/types').AllFilters[T]} requestedFilters
 * @param {Record<string, any>} userSettings
 * @param {T} category
 * @param {string[]} [onlyAreas]
 * @returns
 */
const trimFilters = (requestedFilters, userSettings, category, onlyAreas) => {
  const { filters: staticFilters } = useMemory.getState()
  const easyMode = !!requestedFilters?.easyMode
  const trimmed = {
    onlyLegacy: userSettings?.legacyFilter,
    onlyLinkGlobal: userSettings?.linkGlobalAndAdvanced || easyMode,
    onlyAllPvp: userSettings?.showAllPvpRanks,
    onlyAreas: onlyAreas || [],
  }
  Object.entries(requestedFilters || {}).forEach((topLevelFilter) => {
    const [id, specifics] = topLevelFilter

    if (!FILTER_SKIP_LIST.includes(id)) {
      trimmed[`only${id.charAt(0).toUpperCase()}${id.slice(1)}`] = specifics
    }
  })
  Object.entries(userSettings || {}).forEach(([entryK, entryV]) => {
    if (entryK.startsWith('pvp')) {
      trimmed[`only${entryK.charAt(0).toUpperCase()}${entryK.slice(1)}`] =
        entryV
    }
  })
  Object.entries(requestedFilters?.filter || {}).forEach(([id, specifics]) => {
    // eslint-disable-next-line no-unused-vars
    const { enabled, size, ...rest } = (easyMode
      ? requestedFilters.ivOr
      : specifics) || { all: false, adv: '' }

    if (specifics && specifics.enabled && staticFilters[category]?.filter[id]) {
      trimmed[id] = rest
    }
  })
  return trimmed
}

export function FilterPermCheck({ category }) {
  const valid = usePermCheck(category)
  const error = useMemory((s) => s.clientError)

  if (!valid || error) {
    return null
  }
  return category === 's2cells' ? (
    <GenerateCells />
  ) : (
    <QueryWrapper category={category} />
  )
}

function QueryWrapper({ category }) {
  const timeout = React.useRef(new RobustTimeout(category))
  useAnalytics('Data', `${category} being fetched`, category, true)

  return <QueryData category={category} timeout={timeout} />
}

function QueryData({ category, timeout }) {
  const Component = React.useMemo(() => TILES[category], [])

  const map = useMap()

  const hideList = useMemory((s) => s.hideList)
  const userShinies = useMemory((s) => s.userShinies)
  const hasShinyAccountAccess = useMemory(
    (s) => s.auth.perms.shinyAccount,
  )
  const active = useMemory((s) => s.active)
  const manualParams = useMemory((s) => s.manualParams)
  const showShiniesOnly =
    useStorage((s) => s.showShiniesOnly) && hasShinyAccountAccess

  const userSettings = useStorage(
    (s) => s.userSettings[userSettingsCategory(category)],
  )
  const filters = useStorage((s) => s.filters?.[category])
  const onlyAreas = useStorage(
    (s) =>
      s.filters?.scanAreas?.filterByAreas &&
      s.filters?.scanAreas?.filter?.areas,
  )

  const normalizedCategory = React.useMemo(
    () => normalizeCategory(category),
    [category],
  )
  const manualId = React.useMemo(() => {
    if (
      manualParams?.id === undefined ||
      manualParams.id === '' ||
      manualParams.id === null
    ) {
      return undefined
    }
    const manualCategory = normalizeCategory(manualParams.category)
    return manualCategory === normalizedCategory ? manualParams.id : undefined
  }, [manualParams, normalizedCategory])
  const isManualShiny = useMemory(
    (s) =>
      normalizedCategory === 'pokemon' &&
      manualId !== undefined &&
      s.userShinies.some(
        (sighting) => String(sighting.encounterId) === String(manualId),
      ),
  )

  const buildVariables = React.useCallback(() => {
    const args = getQueryArgs()
    const trimmedFilters = trimFilters(
      filters,
      userSettings,
      category,
      onlyAreas,
    )
    if (
      manualId &&
      MANUAL_ID_CATEGORIES.has(normalizedCategory) &&
      !(isManualShiny && !showShiniesOnly)
    ) {
      trimmedFilters.onlyManualId = manualId
    }
    return {
      ...args,
      filters: trimmedFilters,
    }
  }, [
    filters,
    userSettings,
    category,
    onlyAreas,
    manualId,
    normalizedCategory,
    isManualShiny,
    showShiniesOnly,
  ])

  const initial = React.useMemo(() => buildVariables(), [buildVariables])
  const { data, previousData, error, refetch } = useQuery(
    Query[category](filters),
    {
      context: {
        abortableContext: timeout.current,
      },
      variables: initial,
      fetchPolicy: active
        ? category === 'weather'
          ? 'cache-and-network'
          : 'no-cache'
        : 'cache-only',
      skip: !active,
    },
  )

  React.useEffect(() => {
    if (active) {
      timeout.current.setupTimeout(refetch)
      return () => {
        timeout.current.off()
      }
    }
  }, [active, refetch, timeout.current])

  React.useEffect(() => {
    const refetchData = () => {
      if (category !== 'scanAreas') {
        timeout.current.doRefetch(buildVariables())
      }
    }
    map.on('fetchdata', refetchData)
    refetchData()
    return () => {
      map.off('fetchdata', refetchData)
    }
  }, [category, map, buildVariables, timeout])

  const errorState = useProcessError(error)

  const returnData = errorState
    ? []
    : (data || previousData || { [category]: [] })[category]

  if (!returnData) {
    return error && process.env.NODE_ENV === 'development' ? (
      <Notification
        open
        severity="error"
        i18nKey="server_dev_error_0"
        messages={[
          {
            key: 'error',
            variables: [error?.message],
          },
        ]}
      />
    ) : null
  }

  const pokemonData =
    category === 'pokemon' && showShiniesOnly
      ? [

          ...returnData.filter((pokemon) =>
            userShinies.some(
              (shiny) =>
                String(shiny.encounterId) === String(pokemon.encounter_id),
            ),
          ),

          ...userShinies
            .filter(
              (sighting) =>
                (matchesShinyFilters(
                  sighting,
                  /** @type {Record<string, any> | undefined} */ (filters),
                ) ||
                  matchesQuickIvFilter(
                    sighting,
                    /** @type {Record<string, any> | undefined} */ (filters),
                  )) &&
                !returnData.some(
                  (pokemon) =>
                    String(pokemon.encounter_id) === sighting.encounterId,
                ),
            )
            .map((sighting) => {
              const cleanPvp = sighting.pvp || {}
              return {
                id: sighting.encounterId,
                encounter_id: sighting.encounterId,
                spawnpoint_id: sighting.spawnpoint_id || '',
                pokemon_id: sighting.pokemonId,
                display_pokemon_id: sighting.display_pokemon_id ?? 0,
                display_pokemon_form: sighting.display_pokemon_form ?? 0,
                lat: sighting.latitude,
                lon: sighting.longitude,
                form: sighting.form ?? 0,
                costume: sighting.costume ?? 0,
                gender: sighting.gender ?? 0,
                size: sighting.size ?? 0,
                weight: sighting.weight ?? 0,
                height: sighting.height ?? 0,
                weather: sighting.weather ?? 0,
                move_1: sighting.move_1 ?? 0,
                move_2: sighting.move_2 ?? 0,
                seen_type: sighting.seen_type,
                expire_timestamp: sighting.despawnSec,
                expire_timestamp_verified:
                  sighting.expire_timestamp_verified ?? false,
                first_seen_timestamp: sighting.first_seen_timestamp ?? 0,
                updated: sighting.updated ?? 0,
                iv: sighting.iv ?? null,
                atk_iv: sighting.atk_iv ?? null,
                def_iv: sighting.def_iv ?? null,
                sta_iv: sighting.sta_iv ?? null,
                cp: sighting.cp ?? null,
                level: sighting.level ?? null,
                cleanPvp,
                shiny: true,
                bestPvp: getBestPvpRank(cleanPvp),
              }
            }),
        ]
      : returnData
  const filteredData = pokemonData.filter((each) => !hideList.has(each.id))

  if (category === 'routes') {
    return <RouteLayer routes={filteredData} />
  }

  return (
    <>
      <Clustering category={category}>
        {filteredData.map((each) => (
          <Component key={each.id || category} {...each} />
        ))}
      </Clustering>
      {category === 'weather' && <ActiveWeather weatherData={filteredData} />}
    </>
  )
}
