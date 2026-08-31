import { ElectronAPI } from '@electron-toolkit/preload'
import type { NvagIpcApi } from '@nvag/contracts'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    nvag: NvagIpcApi
  }
}
