import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const AUTH_FILE_NAME = 'auth-token.bin'
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let inMemoryToken: string | null = null

const getTokenFilePath = (): string => {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, AUTH_FILE_NAME)
}

const readSecureToken = (): string | null => {
  const tokenFilePath = getTokenFilePath()

  if (!existsSync(tokenFilePath)) {
    return null
  }

  try {
    const rawBytes = readFileSync(tokenFilePath)

    if (rawBytes.length === 0) {
      return null
    }

    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(rawBytes)
    }

    return rawBytes.toString('utf-8')
  } catch {
    return null
  }
}

const writeSecureToken = (token: string): void => {
  const tokenFilePath = getTokenFilePath()
  const tokenDirectory = dirname(tokenFilePath)

  if (!existsSync(tokenDirectory)) {
    mkdirSync(tokenDirectory, { recursive: true })
  }

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token)
    writeFileSync(tokenFilePath, encrypted)
    return
  }

  writeFileSync(tokenFilePath, Buffer.from(token, 'utf-8'))
}

const clearSecureToken = (): void => {
  const tokenFilePath = getTokenFilePath()

  if (existsSync(tokenFilePath)) {
    unlinkSync(tokenFilePath)
  }
}

const createMainWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1626',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL)
    return
  }

  void mainWindow.loadFile(join(__dirname, '../dist/index.html'))
}

const registerIpcHandlers = (): void => {
  ipcMain.handle('auth:getToken', () => {
    if (inMemoryToken) {
      return inMemoryToken
    }

    inMemoryToken = readSecureToken()
    return inMemoryToken
  })

  ipcMain.handle('auth:setToken', (_event, token: unknown) => {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Token must be a non-empty string')
    }

    inMemoryToken = token
    writeSecureToken(token)
  })

  ipcMain.handle('auth:clearToken', () => {
    inMemoryToken = null
    clearSecureToken()
  })
}

app.whenReady().then(() => {
  inMemoryToken = readSecureToken()
  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
