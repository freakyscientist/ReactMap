// @ts-check
import * as React from 'react'
import { Link, useNavigate } from 'react-router'
import ArrowBack from '@mui/icons-material/ArrowBack'
import AutoAwesome from '@mui/icons-material/AutoAwesome'
import DeleteOutline from '@mui/icons-material/DeleteOutline'
import Refresh from '@mui/icons-material/Refresh'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Container from '@mui/material/Container'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

import { useMemory } from '@store/useMemory'

const apiRequest = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      payload.message || payload.reason || payload.error || 'Request failed',
    )
  }
  return payload
}

const dateText = (value) => (value ? new Date(value).toLocaleString() : '-')

export function ShinyAccountPage() {
  const navigate = useNavigate()
  const auth = useMemory((s) => s.auth)
  const [platform, setPlatform] = React.useState('')
  const [friendCode, setFriendCode] = React.useState('')
  const [profile, setProfile] = React.useState(null)
  const [users, setUsers] = React.useState([])
  const [search, setSearch] = React.useState('')
  const [userToDelete, setUserToDelete] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')

  const availablePlatforms = [
    ...(auth.discordId ? [{ id: 'discord', label: 'Discord', value: auth.discordId }] : []),
    ...(auth.telegramId ? [{ id: 'telegram', label: 'Telegram', value: auth.telegramId }] : []),
  ]

  const loadData = React.useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      if (!auth.loggedIn) {
        setProfile(null)
        setUsers([])
        return
      }
      const status = await apiRequest('/api/zorua/profile/status', {
        method: 'POST',
        body: '{}',
      })
      setProfile(status)
      if (auth.perms.admin) {
        const result = await apiRequest('/api/zorua/users')
        setUsers(result.users || [])
      } else {
        setUsers([])
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [auth.loggedIn, auth.perms.admin])

  React.useEffect(() => {
    loadData()
  }, [loadData])

  React.useEffect(() => {
    if (!availablePlatforms.some((option) => option.id === platform)) {
      setPlatform(availablePlatforms[0]?.id || '')
    }
  }, [platform, auth.discordId, auth.telegramId])

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setNotice('')
    setSaving(true)
    try {
      const result = await apiRequest('/api/zorua/profile', {
        method: 'POST',
        body: JSON.stringify({
          platform,
          friendCode: friendCode.replace(/\s/g, ''),
        }),
      })
      if (result.status !== 'ok') throw new Error(result.message || 'Could not link account')
      setFriendCode('')
      setNotice('Friend code linked. This link can only be removed by an administrator.')
      await loadData()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!userToDelete) return
    setError('')
    try {
      await apiRequest(
        `/api/zorua/users/${encodeURIComponent(userToDelete.target)}`,
        { method: 'DELETE' },
      )
      setNotice(`Link for ${userToDelete.target} revoked.`)
      setUserToDelete(null)
      await loadData()
    } catch (requestError) {
      setError(requestError.message)
      setUserToDelete(null)
    }
  }

  const filteredUsers = users.filter((user) =>
    [
      user.target,
      user.user_type,
      user.discord_id,
      user.telegram_id,
      user.friend_code,
      user.player_id,
      user.label,
      user.status,
    ].some((value) => String(value || '').toLowerCase().includes(search.toLowerCase())),
  )

  return (
    <Container maxWidth="xl" sx={{ py: { xs: 2, md: 4 } }}>
      <Stack spacing={3}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ sm: 'center' }}
          justifyContent="space-between"
          spacing={2}
        >
          <Box>
            <Button
              component={Link}
              to="/"
              startIcon={<ArrowBack />}
              sx={{ mb: 1, px: 0 }}
            >
              Back to map
            </Button>
            <Typography variant="h4" component="h1">
              Shiny account
            </Typography>
            <Typography color="text.secondary">
              Link a friend code to receive personalized shiny notifications and map sightings.
            </Typography>
          </Box>
          <IconButton aria-label="Refresh" onClick={loadData} disabled={loading}>
            <Refresh />
          </IconButton>
        </Stack>

        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}

        {!auth.loggedIn ? (
          <Paper variant="outlined" sx={{ p: 3, maxWidth: 560 }}>
            <Stack spacing={2} alignItems="flex-start">
              <AutoAwesome color="primary" />
              <Typography variant="h6">Sign in to link your account</Typography>
              <Typography color="text.secondary">
                Continue with an eligible Discord or Telegram account in your community.
              </Typography>
              <Button variant="contained" href="/login">Sign in</Button>
            </Stack>
          </Paper>
        ) : loading ? (
          <Box display="flex" justifyContent="center" py={6}><CircularProgress /></Box>
        ) : profile?.linked ? (
          <Paper variant="outlined" sx={{ p: 3, maxWidth: 680 }}>
            <Stack spacing={1}>
              <Typography variant="h6">Friend code linked</Typography>
              <Typography>Lookup status: {profile.status || 'pending'}</Typography>
              <Typography>Player ID: {profile.playerId || 'Waiting for friend lookup'}</Typography>
              <Typography color="text.secondary">
                This link is permanent for your account. Contact an administrator if it needs to be removed.
              </Typography>
            </Stack>
          </Paper>
        ) : (
          <Paper component="form" variant="outlined" onSubmit={handleSubmit} sx={{ p: 3, maxWidth: 680 }}>
            <Stack spacing={2}>
              <Typography variant="h6">Link friend code</Typography>
              {!availablePlatforms.length ? (
                <Alert severity="warning">
                  Link a Discord or Telegram account in your ReactMap profile first.
                </Alert>
              ) : (
                <>
                  <FormControl fullWidth>
                    <InputLabel id="shiny-platform-label">Account</InputLabel>
                    <Select
                      labelId="shiny-platform-label"
                      value={platform}
                      label="Account"
                      onChange={(event) => setPlatform(event.target.value)}
                    >
                      {availablePlatforms.map((option) => (
                        <MenuItem key={option.id} value={option.id}>
                          {option.label} ({option.value})
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <TextField
                    label="Pokémon GO friend code"
                    value={friendCode}
                    onChange={(event) => setFriendCode(event.target.value)}
                    inputProps={{ inputMode: 'numeric', maxLength: 14, pattern: '[0-9 ]{12,14}' }}
                    helperText="Enter the 12-digit code. Spaces are optional."
                    required
                    fullWidth
                  />
                  <Button
                    type="submit"
                    variant="contained"
                    startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <AutoAwesome />}
                    disabled={saving || !platform || friendCode.replace(/\s/g, '').length !== 12}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    Link friend code
                  </Button>
                </>
              )}
            </Stack>
          </Paper>
        )}

        {auth.perms.admin && (
          <Box>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              alignItems={{ sm: 'center' }}
              justifyContent="space-between"
              spacing={2}
              sx={{ mb: 1.5 }}
            >
              <Box>
                <Typography variant="h5" component="h2">Linked users</Typography>
                <Typography color="text.secondary">{filteredUsers.length} of {users.length} profiles</Typography>
              </Box>
              <TextField
                size="small"
                label="Search users"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                sx={{ width: { xs: '100%', sm: 300 } }}
              />
            </Stack>
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: '65vh' }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {[
                      'Target', 'Type', 'Discord ID', 'Telegram ID', 'Friend code',
                      'Player ID', 'Label', 'Status', 'Request sent', 'Accepted',
                      'Claimed by', 'Claim expires', 'Attempts', 'Created', 'Updated',
                      'Raid state', 'Actions',
                    ].map((heading) => <TableCell key={heading}>{heading}</TableCell>)}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredUsers.map((user) => (
                    <TableRow key={user.target} hover>
                      <TableCell>{user.target}</TableCell>
                      <TableCell>{user.user_type}</TableCell>
                      <TableCell>{user.discord_id || '-'}</TableCell>
                      <TableCell>{user.telegram_id || '-'}</TableCell>
                      <TableCell>{user.friend_code}</TableCell>
                      <TableCell>{user.player_id || '-'}</TableCell>
                      <TableCell>{user.label || '-'}</TableCell>
                      <TableCell>{user.status}</TableCell>
                      <TableCell>{String(!!user.friend_request_sent)}</TableCell>
                      <TableCell>{String(!!user.friend_request_accepted)}</TableCell>
                      <TableCell>{user.claimed_by || '-'}</TableCell>
                      <TableCell>{dateText(user.claimed_until)}</TableCell>
                      <TableCell>{user.attempts}</TableCell>
                      <TableCell>{dateText(user.created_at)}</TableCell>
                      <TableCell>{dateText(user.updated_at)}</TableCell>
                      <TableCell sx={{ maxWidth: 260, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {user.raid_state || '-'}
                      </TableCell>
                      <TableCell>
                        <IconButton
                          aria-label={`Revoke ${user.target}`}
                          color="error"
                          onClick={() => setUserToDelete(user)}
                        >
                          <DeleteOutline />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}
      </Stack>

      <Dialog open={!!userToDelete} onClose={() => setUserToDelete(null)}>
        <DialogTitle>Revoke shiny account link?</DialogTitle>
        <DialogContent>
          This removes the Zorua profile and stops future shiny matching for {userToDelete?.target}.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUserToDelete(null)}>Cancel</Button>
          <Button color="error" startIcon={<DeleteOutline />} onClick={handleDelete}>
            Revoke link
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  )
}