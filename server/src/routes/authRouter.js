// @ts-check
const authRouter = require('express').Router()
const passport = require('passport')

const config = require('@rm/config')
const { log, TAGS } = require('@rm/logger')

const { state } = require('../services/state')

// Complete linking after the second provider has been verified by Passport.
async function completeZoruaIdentityLink(req, user, strategy) {
  const pending = req.session?.zoruaPendingLink
  if (!pending) return null
  delete req.session.zoruaPendingLink
  if (pending.platform !== strategy.type || Date.now() > pending.expires) return 'expired'
  const identityId = String(strategy.type === 'discord' ? user.discordId || '' : user.telegramId || '')
  if (!/^\d{1,30}$/.test(identityId)) return 'invalid-provider'
  const url = process.env.ZORUA_MAP_API_URL?.replace(/\/+$/, '')
  const secret = process.env.ZORUA_MAP_API_SECRET
  if (!url || !secret) return 'unavailable'
  try {
    const response = await fetch(`${url}/map/profile/link/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ReactMap-Secret': secret },
      body: JSON.stringify({ code: pending.code, platform: strategy.type, identityId }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      log.warn(TAGS.auth, `Zorua identity linking refused: HTTP ${response.status}`)
      return 'failed'
    }
    return 'success'
  } catch (error) {
    log.error(TAGS.auth, 'Zorua identity linking callback failed', error)
    return 'unavailable'
  }
}

// Loads up the base auth routes and any custom ones

const loadAuthStrategies = () => {
  authRouter.stack = []
  config.getSafe('authentication.strategies').forEach((strategy, i) => {
    const method =
      strategy.type === 'discord' || strategy.type === 'telegram'
        ? 'get'
        : 'post'
    if (strategy.enabled) {
      const name = strategy.name ?? `${strategy.type}-${i}`
      const isDiscordPromptRetry = (req) =>
        strategy.type === 'discord' && req.session.discordPromptRetry === name
      const getAuthenticateOptions = (req, includeRedirects = false) => {
        const options = includeRedirects
          ? {
              failureRedirect: '/',
              successRedirect: '/',
            }
          : {}

        if (
          strategy.type === 'discord' &&
          strategy.clientPrompt &&
          !isDiscordPromptRetry(req)
        ) {
          options.prompt = strategy.clientPrompt
        }

        return options
      }

      authRouter[method](`/${name}`, (req, res, next) =>
        passport.authenticate(name, getAuthenticateOptions(req, true))(
          req,
          res,
          next,
        ),
      )
      authRouter[method](`/${name}/callback`, async (req, res, next) => {
        if (
          strategy.type === 'discord' &&
          strategy.clientPrompt === 'none' &&
          !isDiscordPromptRetry(req) &&
          typeof req.query.error === 'string'
        ) {
          req.session.discordPromptRetry = name
          log.debug(
            TAGS.auth,
            'Discord silent auth needs user interaction, retrying with approval page',
          )
          return res.redirect(`${req.baseUrl}/${name}/callback`)
        }

        if (
          strategy.type === 'discord' &&
          isDiscordPromptRetry(req) &&
          (typeof req.query.code === 'string' ||
            typeof req.query.error === 'string')
        ) {
          delete req.session.discordPromptRetry
        }

        return passport.authenticate(
          name,
          getAuthenticateOptions(req),
          async (err, user, info) => {
            if (err) {
              return next(err)
            }
            if (!user) {
              res.redirect(
                `/blocked/${encodeURIComponent(
                  new URLSearchParams(info).toString(),
                )}`,
              )
            } else {
              try {
                const linkResult = await completeZoruaIdentityLink(req, user, strategy)
                return req.login(user, async () => {
                  const { id } = user
                  if (!(await state.db.models.Session.isValidSession(id))) {
                    log.info(
                      TAGS.auth,
                      'Detected multiple sessions, clearing old ones...',
                    )
                    await state.db.models.Session.clearOtherSessions(
                      id,
                      req.sessionID,
                    )
                  }
                  return res.redirect(linkResult ? `/shiny-account?identityLink=${encodeURIComponent(linkResult)}` : '/')
                })
              } catch (error) {
                log.error(TAGS.auth, error)
                res.redirect('/')
                next(error)
              }
            }
          },
        )(req, res, next)
      })
      log.info(
        TAGS.auth,
        `${method.toUpperCase()} /auth/${name}/callback route initialized`,
      )
    }
  })

  authRouter.get('/logout', (req, res) => {
    req.logout((err) => {
      if (err) log.error(TAGS.auth, 'Unable to logout', err)
    })
    // req.session.destroy()
    res.redirect('/')
  })

  log.debug(TAGS.auth, 'Auth Router Stack Size:', authRouter.stack.length)
}

loadAuthStrategies()

module.exports = { loadAuthStrategies, authRouter }
