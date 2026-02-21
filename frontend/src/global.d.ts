export {}

declare global {
  interface DesktopAuthBridge {
    getToken: () => Promise<string | null>
    setToken: (token: string) => Promise<void>
    clearToken: () => Promise<void>
  }

  interface DesktopConfigBridge {
    gatewayUrl: string
  }

  interface Window {
    desktopAuth?: DesktopAuthBridge
    desktopConfig?: DesktopConfigBridge
  }
}
