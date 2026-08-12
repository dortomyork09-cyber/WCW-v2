const { ipcMain, shell } = require('electron')
const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

const TOKEN_PATH = path.join(__dirname, 'gcal_token.json')
const CRED_PATH = path.join(__dirname, 'credentials.json')
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly'
const REDIRECT_PORT = 3737
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

function loadCreds() {
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, 'utf-8'))
  } catch(e) { return null }
}

function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
  } catch(e) { return null }
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token))
}

function httpsGet(url, headers={}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch(e) { resolve(null) }
      })
    }).on('error', reject)
  })
}

function httpsPost(hostname, path, data, headers={}) {
  return new Promise((resolve, reject) => {
    const body = typeof data === 'string' ? data : new URLSearchParams(data).toString()
    const opts = {
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...headers }
    }
    const req = https.request(opts, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch(e) { resolve(null) } })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function refreshToken(creds, token) {
  const res = await httpsPost('oauth2.googleapis.com', '/token', {
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token'
  })
  if (res && res.access_token) {
    const newToken = { ...token, access_token: res.access_token, expiry: Date.now() + (res.expires_in || 3600) * 1000 }
    saveToken(newToken)
    return newToken
  }
  return null
}

async function getValidToken() {
  const creds = loadCreds()
  if (!creds) return null
  let token = loadToken()
  if (!token) return null
  if (!token.expiry || Date.now() > token.expiry - 60000) {
    token = await refreshToken(creds, token)
  }
  return token
}

async function fetchEvents(token) {
  const now = new Date().toISOString()
  const future = new Date(Date.now() + 30 * 86400000).toISOString()
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&timeMax=${encodeURIComponent(future)}&singleEvents=true&orderBy=startTime&maxResults=50`
  return httpsGet(url, { Authorization: 'Bearer ' + token.access_token })
}

function setupGcal(win) {
  // 로그인 상태 확인
  ipcMain.handle('gcal-status', async () => {
    const token = await getValidToken()
    return { loggedIn: !!token }
  })

  // 로그인 (OAuth 플로우)
  ipcMain.handle('gcal-login', async () => {
    const creds = loadCreds()
    if (!creds) return { error: 'credentials.json 파일이 없어요' }

    return new Promise((resolve) => {
      // 로컬 서버로 redirect 받기
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`)
        const code = url.searchParams.get('code')
        if (!code) { res.end('오류'); resolve({ error: '코드 없음' }); server.close(); return }

        res.end('<html><body style="background:#1a1a2e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>✅ WCW 연결 완료!</h2><p>이 창을 닫아도 됩니다.</p></div></body></html>')
        server.close()

        // 코드로 토큰 교환
        const tokenRes = await httpsPost('oauth2.googleapis.com', '/token', {
          code,
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code'
        })

        if (tokenRes && tokenRes.access_token) {
          const token = {
            access_token: tokenRes.access_token,
            refresh_token: tokenRes.refresh_token,
            expiry: Date.now() + (tokenRes.expires_in || 3600) * 1000
          }
          saveToken(token)
          resolve({ success: true })
        } else {
          resolve({ error: '토큰 교환 실패' })
        }
      })

      server.listen(REDIRECT_PORT, () => {
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${creds.client_id}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`
        shell.openExternal(authUrl)
      })

      server.on('error', (e) => resolve({ error: '서버 오류: ' + e.message }))

      // 2분 타임아웃
      setTimeout(() => { server.close(); resolve({ error: '시간 초과' }) }, 120000)
    })
  })

  // 로그아웃
  ipcMain.handle('gcal-logout', async () => {
    try { fs.unlinkSync(TOKEN_PATH) } catch(e) {}
    return { success: true }
  })

  // 일정 가져오기
  ipcMain.handle('gcal-events', async () => {
    try {
      const token = await getValidToken()
      if (!token) return { error: 'not_logged_in' }
      const data = await fetchEvents(token)
      if (!data) return { error: '데이터 없음' }
      if (data.error) return { error: data.error.message || '오류' }
      const events = (data.items || []).map(ev => ({
        id: ev.id,
        title: ev.summary || '(제목 없음)',
        start: ev.start.dateTime || ev.start.date,
        end: ev.end.dateTime || ev.end.date,
        allDay: !ev.start.dateTime,
        color: ev.colorId ? '#'+['','tomato','flamingo','tangerine','banana','sage','basil','peacock','blueberry','lavender','grape','graphite'][parseInt(ev.colorId)]||'#4f8ef7' : '#4f8ef7',
        location: ev.location || '',
        desc: ev.description || ''
      }))
      return { events }
    } catch(e) {
      return { error: e.message }
    }
  })
}

module.exports = { setupGcal }