import { contextBridge, ipcRenderer } from 'electron'

const gatewayUrl = process.env.GATEWAY_URL ?? process.env.VITE_GATEWAY_URL ?? ''

contextBridge.exposeInMainWorld('desktopAuth', {
  getToken: (): Promise<string | null> => ipcRenderer.invoke('auth:getToken'),
  setToken: (token: string): Promise<void> => ipcRenderer.invoke('auth:setToken', token),
  clearToken: (): Promise<void> => ipcRenderer.invoke('auth:clearToken'),
})

contextBridge.exposeInMainWorld('desktopConfig', {
  gatewayUrl,
})
