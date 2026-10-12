// @ts-check

const express = require('express')
const { log, TAGS } = require('@rm/logger')

const { state } = require('../services/state')

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

zoruaRouter.post('/profile/status', async (req, res) => {
  if (!requireLogin(req, res)) return
  const zorua = getZoruaConfig(res)
  if (!zorua) return
  const identity = {
    discordId: req.user.discordId || '',
    telegramId: req.user.telegramId || '',
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
    }),
  })
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