const assert = require('node:assert/strict')
const http = require('node:http')
const { test } = require('node:test')

const express = require('express')
const config = require('@rm/config')

const { state } = require('./stateMock')
const { zoruaRouter } = require('../src/routes/zoruaRouter')

const secret = 'shared-map-secret-for-tests'

function sessionQuery(sessions) {
  const identityQuery = {
    whereRaw() {
      return this
    },
    orWhereRaw() {
      return this
    },
  }
  const query = {
    select() {
      return this
    },
    limit() {
      return this
    },
    where(...args) {
      if (typeof args[0] === 'function') args[0](identityQuery)
      return this
    },
    then(resolve, reject) {
      return Promise.resolve(sessions).then(resolve, reject)
    },
  }
  return query
}

async function startServer(t, sessions) {
  const previousSession = state.db.models.Session
  state.db.models.Session = { query: () => sessionQuery(sessions) }
  const previousSecret = process.env.ZORUA_MAP_API_SECRET
  process.env.ZORUA_MAP_API_SECRET = secret

  const app = express()
  app.use(express.json())
  app.use('/api/zorua', zoruaRouter)
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    state.db.models.Session = previousSession
    if (previousSecret === undefined) delete process.env.ZORUA_MAP_API_SECRET
    else process.env.ZORUA_MAP_API_SECRET = previousSecret
  })
  return `http://127.0.0.1:${server.address().port}/api/zorua/area-check`
}

function mockAreaConfig(t) {
  t.mock.method(config, 'getSafe', (key) => {
    if (key === 'authentication') {
      return { strictAreaRestrictions: false, areaRestrictions: [] }
    }
    if (key === 'areas') {
      return {
        names: new Set(),
        scanAreasObj: {},
        myRTree: { search: () => [] },
      }
    }
    throw new Error(`Unexpected config lookup: ${key}`)
  })
}

test('Zorua area check requires the shared secret and permits the active user area', async (t) => {
  mockAreaConfig(t)
  const url = await startServer(t, [
    {
      data: JSON.stringify({
        passport: {
          user: {
            discordId: '123456789012345678',
            perms: { map: true, areaRestrictions: [] },
          },
        },
      }),
    },
  ])

  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      discordId: '123456789012345678',
      latitude: 35.9,
      longitude: 14.5,
    }),
  })
  assert.equal(unauthorized.status, 401)

  const allowed = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ReactMap-Secret': secret,
    },
    body: JSON.stringify({
      discordId: '123456789012345678',
      latitude: 35.9,
      longitude: 14.5,
    }),
  })
  assert.deepEqual(await allowed.json(), { status: 'ok', allowed: true })
})

test('Zorua area check denies missing sessions, multiple sessions, and unresolvable areas', async (t) => {
  mockAreaConfig(t)
  const sessions = [
    {
      data: JSON.stringify({
        passport: {
          user: {
            discordId: '123456789012345678',
            perms: { map: true, areaRestrictions: ['missing-area'] },
          },
        },
      }),
    },
  ]
  const url = await startServer(t, sessions)
  const request = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ReactMap-Secret': secret,
    },
    body: JSON.stringify({
      discordId: '123456789012345678',
      latitude: 35.9,
      longitude: 14.5,
    }),
  }

  const deniedArea = await fetch(url, request)
  assert.deepEqual(await deniedArea.json(), { status: 'ok', allowed: false })

  sessions.length = 0
  const noSession = await fetch(url, request)
  assert.deepEqual(await noSession.json(), { status: 'ok', allowed: false })

  sessions.push({ data: '{}' }, { data: '{}' })
  const multipleSessions = await fetch(url, request)
  assert.deepEqual(await multipleSessions.json(), { status: 'ok', allowed: false })
})

test('Zorua area check applies the active session polygon restrictions', async (t) => {
  const feature = {
    type: 'Feature',
    properties: { key: 'restricted' },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ]],
    },
  }
  t.mock.method(config, 'getSafe', (key) => {
    if (key === 'authentication') {
      return { strictAreaRestrictions: false, areaRestrictions: [] }
    }
    if (key === 'areas') {
      return {
        names: new Set(['restricted']),
        scanAreasObj: {},
        myRTree: { search: () => [feature] },
      }
    }
    throw new Error(`Unexpected config lookup: ${key}`)
  })
  const url = await startServer(t, [
    {
      data: JSON.stringify({
        passport: {
          user: {
            discordId: '123456789012345678',
            perms: { map: true, areaRestrictions: ['restricted'] },
          },
        },
      }),
    },
  ])
  const request = (latitude, longitude) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ReactMap-Secret': secret,
      },
      body: JSON.stringify({
        discordId: '123456789012345678',
        latitude,
        longitude,
      }),
    })

  const inside = await request(0, 0)
  assert.deepEqual(await inside.json(), { status: 'ok', allowed: true })

  const outside = await request(35.9, 14.5)
  assert.deepEqual(await outside.json(), { status: 'ok', allowed: false })
})
