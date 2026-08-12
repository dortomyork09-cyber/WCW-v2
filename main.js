const { app, BrowserWindow, screen, ipcMain, Tray, Menu } = require('electron')
const { setupGcal } = require('./gcal')
const { exec } = require('child_process')
const path = require('path')
const https = require('https')

let win = null
let tray = null

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width, height, x: 0, y: 0,
    frame: false, transparent: true, alwaysOnTop: false,
    skipTaskbar: false, resizable: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })

  win.loadFile('index.html')
  win.setIgnoreMouseEvents(true, { forward: true })

  ipcMain.on('set-ignore-mouse', (e, ignore) => {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(ignore, { forward: true })
  })

  const ctrlPath = path.join(__dirname, 'control.ps1')
  const volPath = path.join(__dirname, 'volume.ps1')
  const mediaPath = path.join(__dirname, 'media.ps1')

  ipcMain.on('media-control', (e, action, value) => {
    const val = value !== undefined ? value : 0
    exec(`powershell -ExecutionPolicy Bypass -NoProfile -File "${ctrlPath}" -action "${action}" -value ${val}`)
  })

  ipcMain.on('set-volume', (e, level) => {
    exec(`powershell -ExecutionPolicy Bypass -NoProfile -File "${volPath}" -level ${level}`)
  })

  // 미디어 폴링
  setInterval(() => {
    exec(`powershell -ExecutionPolicy Bypass -NoProfile -File "${mediaPath}"`, { encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout.trim()) return
      try {
        const data = JSON.parse(stdout.trim())
        if (win && !win.isDestroyed()) win.webContents.send('media-update', data)
      } catch(e) {}
    })
  }, 1500)

  // 초기 볼륨
  setTimeout(() => {
    exec(`powershell -ExecutionPolicy Bypass -NoProfile -File "${volPath}"`, { encoding: 'utf8' }, (err, stdout) => {
      if (!err && stdout.trim() && win && !win.isDestroyed()) {
        win.webContents.send('volume-update', parseInt(stdout.trim()))
      }
    })
  }, 2000)

  // ===== 뉴스 RSS (Node.js — CORS 없음) =====
  ipcMain.handle('fetch-news', async () => {
    return new Promise((resolve) => {
      https.get('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko',
        { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', () => resolve(null))
    })
  })

  // ===== 범용 URL fetch (리다이렉트 추적 + 타임아웃) =====
  ipcMain.handle('fetch-url', async (event, url) => {
    function get(u, depth) {
      return new Promise((resolve) => {
        if (depth > 5) { resolve(null); return }
        const req = https.get(u, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8'
          }
        }, (res) => {
          // 리다이렉트 추적
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            const next = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, u).href
            resolve(get(next, depth + 1))
            return
          }
          if (res.statusCode !== 200) { res.resume(); resolve(null); return }
          let data = ''
          res.setEncoding('utf8')
          res.on('data', chunk => data += chunk)
          res.on('end', () => resolve(data))
        })
        req.on('error', () => resolve(null))
        req.setTimeout(10000, () => { req.destroy(); resolve(null) })
      })
    }
    return get(url, 0)
  })

  // ===== 날씨 (Open-Meteo — API 키 불필요) =====
  ipcMain.handle('fetch-weather', async (event, lat, lon) => {
    return new Promise((resolve) => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FSeoul&forecast_days=1`
      https.get(url, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch(e) { resolve(null) }
        })
      }).on('error', () => resolve(null))
    })
  })


  // ===== 번역 (Google Translate 비공식 엔드포인트) =====
  ipcMain.handle('translate', async (event, text, from, to) => {
    return new Promise((resolve) => {
      const q = encodeURIComponent(text)
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${q}`
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            let out = ''
            if (j && j[0]) j[0].forEach(seg => { if (seg && seg[0]) out += seg[0] })
            resolve(out || null)
          } catch (e) { resolve(null) }
        })
      }).on('error', () => resolve(null))
    })
  })

  // ===== 축구 경기 (football-data.org 무료 티어) =====
  ipcMain.handle('fetch-football', async (event, league) => {
    return new Promise((resolve) => {
      const today = new Date()
      const from = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10)
      const to = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10)
      const url = `https://api.football-data.org/v4/competitions/${league}/matches?dateFrom=${from}&dateTo=${to}`
      https.get(url, {
        headers: {
          'X-Auth-Token': '',
          'User-Agent': 'Mozilla/5.0'
        }
      }, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            if (j.errorCode || !j.matches) {
              resolve({ error: 'API 키가 필요해요' })
              return
            }
            const matches = j.matches.map(m => ({
              home: m.homeTeam.shortName || m.homeTeam.name,
              away: m.awayTeam.shortName || m.awayTeam.name,
              hs: m.score.fullTime.home,
              as: m.score.fullTime.away,
              status: m.status,
              date: new Date(m.utcDate).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
            }))
            resolve({ matches })
          } catch (e) { resolve({ error: '데이터 오류' }) }
        })
      }).on('error', () => resolve({ error: '연결 실패' }))
    })
  })

  // ===== 자동 시작 설정 =====
  ipcMain.handle('get-autostart', async () => {
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.handle('set-autostart', async (event, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: []
    })
    return app.getLoginItemSettings().openAtLogin
  })

  // ===== 실제 CPU/RAM =====
  function getSystemInfo() {
    const script = `
      $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
      $os = Get-CimInstance Win32_OperatingSystem
      $totalMem = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
      $freeMem = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
      $usedMem = [math]::Round($totalMem - $freeMem, 1)
      Write-Output "{\\"cpu\\":$cpu,\\"used\\":$usedMem,\\"total\\":$totalMem}"
    `
    exec(`powershell -NoProfile -Command "${script}"`, { encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout.trim()) return
      try {
        const data = JSON.parse(stdout.trim())
        if (win && !win.isDestroyed()) win.webContents.send('system-update', data)
      } catch(e) {}
    })
  }
  getSystemInfo()
  setInterval(getSystemInfo, 2000)
  setupGcal(win)
}

app.whenReady().then(() => {
  createWindow()

  // 트레이 아이콘 (선택사항 — icon.png 없으면 무시)
  try {
    const iconPath = path.join(__dirname, 'icon.png')
    const fs = require('fs')
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath)
      const menu = Menu.buildFromTemplate([
        { label: 'WCW 보이기', click: () => { if (win) win.show() } },
        { type: 'separator' },
        { label: '종료', click: () => app.quit() }
      ])
      tray.setToolTip('WCW 위젯')
      tray.setContextMenu(menu)
    }
  } catch(e) {}
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })