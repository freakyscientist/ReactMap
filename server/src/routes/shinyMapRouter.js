// @ts-check

const express = require('express')
const { log, TAGS } = require('@rm/logger')
const { filterRTree } = require('../utils/filterRTree')
const { areaRestrictionsDenyAll } = require('../utils/getAreaSql')

const shinyMapRouter = express.Router()
const ivOnlyFields = [
  'cp',
  'iv',
  'atk_iv',
  'def_iv',
  'sta_iv',
  'level',
  'move_1',
  'move_2',
]

function filterShiniesByAreaAccess(shinies, areaRestrictions) {
  if (areaRestrictionsDenyAll(areaRestrictions, [])) return []
  return shinies.filter((sighting) => {
    const { latitude, longitude } = sighting || {}
    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return false
    }
    return filterRTree({ lat: latitude, lon: longitude }, areaRestrictions, [])
  })
}

shinyMapRouter.get('/', async (req, res) => {
  if (!req.isAuthenticated() || !req.user) {
    log.warn(TAGS.api, 'Unauthenticated request for ReactMap shiny map feed')
    return res
      .status(401)
      .json({ status: 'authError', message: 'login required' })
  }
  if (!req.user.perms?.map) {
    log.warn(TAGS.api, 'ReactMap shiny map feed denied: map permission is missing')
    return res
      .status(403)
      .json({ status: 'error', message: 'map permission required' })
  }
  if (!req.user.perms?.shinyAccount) {
    log.warn(
      TAGS.api,
      'ReactMap shiny map feed denied: shiny account permission is missing',
    )
    return res
      .status(403)
      .json({ status: 'error', message: 'shiny account permission required' })
  }

  const url = process.env.ZORUA_MAP_API_URL?.replace(/\/+$/, '')
  const secret = process.env.ZORUA_MAP_API_SECRET
  if (!url || !secret) {
    log.error(
      TAGS.api,
      `ReactMap shiny map feed is not configured (url=${Boolean(url)}, secret=${Boolean(secret)})`,
    )
    return res
      .status(503)
      .json({ status: 'error', message: 'shiny map feed is not configured' })
  }

  const identity = {
    ...(req.user.discordId ? { discordId: String(req.user.discordId) } : {}),
    ...(req.user.telegramId ? { telegramId: String(req.user.telegramId) } : {}),
    // Zorua checks this host against its configured allowlist.
    domain: req.hostname.toLowerCase(),
  }
  if (Object.keys(identity).length === 0) {
    log.warn(
      TAGS.api,
      'ReactMap shiny map feed user has no Discord or Telegram identity',
    )
    return res.status(200).json({ status: 'ok', shinies: [] })
  }

  let response
  try {
    response = await fetch(`${url}/map/shinies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ReactMap-Secret': secret,
      },
      body: JSON.stringify(identity),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
  } catch (error) {
    log.error(TAGS.api, 'Failed to reach Zorua shiny map feed', error)
    return res
      .status(502)
      .json({ status: 'error', message: 'shiny map feed unavailable' })
  }

  if (!response.ok) {
    log.error(TAGS.api, `Zorua shiny map feed returned HTTP ${response.status}`)
    return res
      .status(502)
      .json({ status: 'error', message: 'shiny map feed unavailable' })
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    log.error(TAGS.api, 'Zorua shiny map feed returned invalid JSON', error)
    return res
      .status(502)
      .json({ status: 'error', message: 'invalid shiny map feed response' })
  }
  if (!payload || !Array.isArray(payload.shinies)) {
    log.error(
      TAGS.api,
      'Zorua shiny map feed response is missing the shinies array',
    )
    return res
      .status(502)
      .json({ status: 'error', message: 'invalid shiny map feed response' })
  }

  const areaVisibleShinies = filterShiniesByAreaAccess(
    payload.shinies,
    req.user.perms.areaRestrictions || [],
  )
  const shinies = areaVisibleShinies.map((sighting) => {
    const filteredSighting = { ...sighting }
    if (!req.user.perms.iv) {
      ivOnlyFields.forEach((field) => delete filteredSighting[field])
    }
    if (!req.user.perms.pvp) delete filteredSighting.pvp
    return filteredSighting
  })
  log.info(
    TAGS.api,
    `ReactMap shiny map feed poll completed: sightings=${payload.shinies.length} area_visible=${shinies.length}`,
  )
  return res.status(200).json({ status: 'ok', shinies })
})

module.exports = { shinyMapRouter, filterShiniesByAreaAccess }
