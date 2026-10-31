const { contextBridge, ipcRenderer } = require('electron')

const messageListeners = new Set()

ipcRenderer.on('host-event', (_event, message) => {
  const event = { data: message }
  for (const listener of messageListeners) {
    try { listener(event) } catch (error) { console.error(error) }
  }
})

contextBridge.exposeInMainWorld('lsaDesktop', {
  platform: process.platform,
  host: {
    postMessage(message) { ipcRenderer.send('host-call', message) },
    addEventListener(type, listener) {
      if (type === 'message' && typeof listener === 'function') messageListeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'message') messageListeners.delete(listener)
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke('window-action', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window-action', 'toggle-maximize'),
    close: () => ipcRenderer.invoke('window-action', 'close'),
    state: () => ipcRenderer.invoke('window-action', 'state'),
  },
})

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add(`platform-${process.platform}`)
})

