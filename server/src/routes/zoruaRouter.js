// @ts-check

const { timingSafeEqual } = require('crypto')
const express = require('express')
const { log, TAGS } = require('@rm/logger')

const { state } = require('../services/state')
const { filterShiniesByAreaAccess } = require('./shinyMapRouter')

const zoruaRouter = express.Router()

function requireLogin(req, res) {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ status: 'authError', message: 'login required' })
    return false
  }
  if (!req.user.perms?.map) {
    res.status(403).json({ status: 'error', message: 'map permission required' })
    return false
  }
  if (!req.user.perms?.shinyAccount) {
    res.status(403).json({ status: 'error', message: 'shiny account permission required' })
    return false
  }
  return true
}

function getZoruaConfig(res) {
  const url = process.env.ZORUA_MAP_API_URL?.replace(/\/+$/, '')
  const secret = process.env.ZORUA_MAP_API_SECRET
  if (!url || !secret) {
    res.status(503).json({ status: 'error', message: 'Zorua profile service is not configured' })
    return null
  }
  return { url, secret }
}

function matchesSharedSecret(provided, expected) {
  const providedBuffer = Buffer.from(provided || '')
  const expectedBuffer = Buffer.from(expected || '')
  return (
    providedBuffer.length === expectedBuffer.length &&
    providedBuffer.length > 0 &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  )
}

function normalizeProviderID(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) return null
  return value
}

async function requestZorua(res, path, secret, options = {}) {
  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-ReactMap-Secret': secret,
        ...options.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new Error('Zorua returned invalid JSON')
    }
    if (!response.ok) {
      return res.status(response.status).json(payload)
    }
    return res.status(response.status).json(payload)
  } catch (error) {
    log.error(TAGS.api, 'Zorua profile API request failed', error)
    return res.status(502).json({ status: 'error', message: 'Zorua profile service unavailable' })
  }
}

async function isDiscordGuildMember(userId) {
  for (const client of Object.values(state.event.authClients)) {
    if (client?.strategy?.type !== 'discord') continue
    for (const guildId of client.strategy.allowedGuilds || []) {
      try {
        const guild =
          client.client.guilds.cache.get(guildId) ||
          (await client.client.guilds.fetch(guildId))
        await guild.members.fetch(userId)
        return true
      } catch {
        continue
      }
    }
  }
  return false
}

async function isTelegramGroupMember(userId, username) {
  for (const client of Object.values(state.event.authClients)) {
    if (client?.strategy?.type !== 'telegram') continue
    const requiredGroups = client.strategy.groups || []
    if (!requiredGroups.length) continue
    const groups = await client.getUserGroups({ id: userId, username })
    if (
      requiredGroups.some((group) =>
        groups.some((memberGroup) => String(memberGroup) === String(group)),
      )
    ) {
      return true
    }
  }
  return false
}

async function isCommunityMember(platform, identityId, username) {
  if (platform === 'discord') return isDiscordGuildMember(identityId)
  if (platform === 'telegram')
    return isTelegramGroupMember(identityId, username)
  return false
}

zoruaRouter.post('/area-check', async (req, res) => {
  const secret = process.env.ZORUA_MAP_API_SECRET || ''
  if (!secret) {
    return res
      .status(503)
      .json({ status: 'error', message: 'Zorua area check is not configured' })
  }
  if (!matchesSharedSecret(req.get('X-ReactMap-Secret'), secret)) {
    return res
      .status(401)
      .json({ status: 'authError', message: 'invalid shared secret' })
  }

  const discordId = normalizeProviderID(req.body?.discordId)
  const telegramId = normalizeProviderID(req.body?.telegramId)
  const { latitude, longitude } = req.body || {}
  if (
    discordId === null ||
    telegramId === null ||
    (!discordId && !telegramId) ||
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return res.status(400).json({
      status: 'error',
      message: 'provider ID and valid latitude/longitude are required',
    })
  }

  try {
    const sessions = await state.db.models.Session.query()
      .select('data')
      .where('expires', '>=', Math.floor(Date.now() / 1000))
      .limit(2)
      .where((query) => {
        let hasIdentity = false
        if (discordId) {
          query.whereRaw(
            "JSON_UNQUOTE(JSON_EXTRACT(data, '$.passport.user.discordId')) = ?",
            [discordId],
          )
          hasIdentity = true
        }
        if (telegramId) {
          query[hasIdentity ? 'orWhereRaw' : 'whereRaw'](
            "JSON_UNQUOTE(JSON_EXTRACT(data, '$.passport.user.telegramId')) = ?",
            [telegramId],
          )
        }
      })

    if (sessions.length !== 1) {
      if (sessions.length > 1) {
        log.warn(
          TAGS.api,
          'Zorua area check denied because multiple active ReactMap sessions matched',
        )
      }
      return res.status(200).json({ status: 'ok', allowed: false })
    }

    const rawData = sessions[0].data
    const sessionData =
      typeof rawData === 'string' ? JSON.parse(rawData) : rawData
    const user = sessionData?.passport?.user
    const identityMatches =
      (discordId && String(user?.discordId || '') === discordId) ||
      (telegramId && String(user?.telegramId || '') === telegramId)
    const areaRestrictions = user?.perms?.areaRestrictions
    const allowed =
      user?.perms?.map === true &&
      user?.perms?.shinyAccount === true &&
      identityMatches &&
      Array.isArray(areaRestrictions) &&
      filterShiniesByAreaAccess(
        [{ latitude, longitude }],
        areaRestrictions,
      ).length === 1

    return res.status(200).json({ status: 'ok', allowed })
  } catch (error) {
    log.error(TAGS.api, 'ReactMap Zorua area check failed', error)
    return res
      .status(500)
      .json({ status: 'error', message: 'area permission check failed' })
  }
})

zoruaRouter.post('/profile/status', async (req, res) => {
  if (!requireLogin(req, res)) return
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  const identity = {
    discordId: req.user.discordId || '',
    telegramId: req.user.telegramId || '',
    domain: req.hostname.toLowerCase(),
  }
  return requestZorua(res, `${zorua.url}/map/profile/status`, zorua.secret, {
    method: 'POST',
    body: JSON.stringify(identity),
  })
})

zoruaRouter.post('/profile', async (req, res) => {
  if (!requireLogin(req, res)) return
  const { platform, friendCode } = req.body || {}
  if (platform !== 'discord' && platform !== 'telegram') {
    return res.status(400).json({ status: 'error', message: 'Choose Discord or Telegram' })
  }
  const identityId = String(
    platform === 'discord' ? req.user.discordId || '' : req.user.telegramId || '',
  )
  if (!/^\d{1,30}$/.test(identityId)) {
    return res.status(403).json({ status: 'error', message: `No verified ${platform} account is linked to this ReactMap session` })
  }
  if (!(await isCommunityMember(platform, identityId, req.user.username))) {
    return res.status(403).json({ status: 'error', message: 'Guild or group membership is required to link a friend code' })
  }
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  return requestZorua(res, `${zorua.url}/map/profile`, zorua.secret, {
    method: 'POST',
    body: JSON.stringify({
      platform,
      identityId,
      friendCode,
      label: req.user.username || identityId,
      domain: req.hostname.toLowerCase(),
    }),
  })
})

// Initiate linking from the account that already owns the Zorua profile.
zoruaRouter.post('/profile/link/start', async (req, res) => {
  if (!requireLogin(req, res)) return
  const { platform } = req.body || {}
  if (platform !== 'discord' && platform !== 'telegram') {
    return res.status(400).json({ status: 'error', message: 'invalid platform' })
  }
  const identityId = String(platform === 'discord' ? req.user.discordId || '' : req.user.telegramId || '')
  if (!/^\d{1,30}$/.test(identityId)) {
    return res.status(403).json({ status: 'error', message: 'provider not verified in current session' })
  }
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  return requestZorua(res, `${zorua.url}/map/profile/link/start`, zorua.secret, {
    method: 'POST',
    body: JSON.stringify({ platform, identityId }),
  })
})

// Complete linking while authenticated with the other provider.
zoruaRouter.post('/profile/link/finish', async (req, res) => {
  if (!requireLogin(req, res)) return
  const { platform, code } = req.body || {}
  if (platform !== 'discord' && platform !== 'telegram') {
    return res.status(400).json({ status: 'error', message: 'invalid platform' })
  }
  const identityId = String(platform === 'discord' ? req.user.discordId || '' : req.user.telegramId || '')
  if (!/^\d{1,30}$/.test(identityId)) {
    return res.status(403).json({ status: 'error', message: 'provider not verified in current session' })
  }
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
    return res.status(400).json({ status: 'error', message: 'invalid link code' })
  }
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  return requestZorua(res, `${zorua.url}/map/profile/link/finish`, zorua.secret, {
    method: 'POST',
    body: JSON.stringify({ platform, identityId, code }),
  })
})

// The link token stays server-side while the browser completes OAuth.
zoruaRouter.post('/profile/link/oauth', async (req, res) => {
  if (!requireLogin(req, res)) return
  const targetPlatform = req.body?.platform
  const sourcePlatform = targetPlatform === 'telegram' ? 'discord' : targetPlatform === 'discord' ? 'telegram' : ''
  if (!sourcePlatform) return res.status(400).json({ status: 'error', message: 'invalid platform' })
  const identityId = String(sourcePlatform === 'discord' ? req.user.discordId || '' : req.user.telegramId || '')
  if (!/^\d{1,30}$/.test(identityId)) return res.status(403).json({ status: 'error', message: 'source provider not verified' })
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  try {
    const response = await fetch(`${zorua.url}/map/profile/link/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ReactMap-Secret': zorua.secret },
      body: JSON.stringify({ platform: sourcePlatform, identityId }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    })
    const data = await response.json()
    if (!response.ok || typeof data.code !== 'string') {
      return res.status(response.status).json({ status: 'error', message: data.message || 'link unavailable' })
    }
    req.session.zoruaPendingLink = { code: data.code, platform: targetPlatform, expires: Date.now() + 600000 }
    return req.session.save((err) => err
      ? res.status(500).json({ status: 'error', message: 'session save failed' })
      : res.json({ status: 'ok' }))
  } catch (error) {
    log.error(TAGS.api, 'Zorua OAuth linking failed to start', error)
    return res.status(502).json({ status: 'error', message: 'link service unavailable' })
  }
})

zoruaRouter.get('/users', (req, res) => {
  if (!requireLogin(req, res)) return
  if (!req.user.perms?.admin) {
    return res.status(403).json({ status: 'error', message: 'admin permission required' })
  }
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  return requestZorua(res, `${zorua.url}/map/users`, zorua.secret)
})

zoruaRouter.delete('/users/:target', (req, res) => {
  if (!requireLogin(req, res)) return
  if (!req.user.perms?.admin) {
    return res.status(403).json({ status: 'error', message: 'admin permission required' })
  }
  if (!/^\d{1,30}$/.test(req.params.target)) {
    return res.status(400).json({ status: 'error', message: 'invalid target' })
  }
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  return requestZorua(
    res,
    `${zorua.url}/map/users/${encodeURIComponent(req.params.target)}`,
    zorua.secret,
    { method: 'DELETE' },
  )
})

module.exports = { zoruaRouter, isCommunityMember }