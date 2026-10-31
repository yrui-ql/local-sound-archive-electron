const desktop = window.lsaDesktop

if (desktop) {
  document.body.classList.add('platform-' + desktop.platform)

  // The original renderer talks to WebView2 through window.chrome.webview.
  // Electron exposes the same small surface through the preload bridge.
  window.chrome = window.chrome || {}
  window.chrome.webview = {
    postMessage(message) { desktop.host.postMessage(message) },
    addEventListener(type, listener) { desktop.host.addEventListener(type, listener) },
    removeEventListener(type, listener) { desktop.host.removeEventListener(type, listener) },
  }
}

const controls = document.getElementById('windowControls')
const drag = document.getElementById('windowDrag')

if (controls && desktop) {
  controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-window-action]')
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const action = button.dataset.windowAction
    if (action === 'minimize') desktop.window.minimize()
    else if (action === 'toggle-maximize') desktop.window.toggleMaximize()
    else if (action === 'close') desktop.window.close()
  })

  controls.addEventListener('dblclick', (event) => event.stopPropagation())
}

if (drag && desktop) {
  drag.addEventListener('dblclick', () => desktop.window.toggleMaximize())
}
// Hide scrollbars until the user actually scrolls a panel.
(() => {
  const selector = '.main,.sidebar,.account-card,.fx-body,.queue-list,.lyrics-list,.search-results,.settings-main'
  const timers = new WeakMap()
  document.addEventListener('scroll', (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.matches(selector)) return
    target.classList.add('is-scrolling')
    const previous = timers.get(target)
    if (previous) clearTimeout(previous)
    timers.set(target, setTimeout(() => {
      target.classList.remove('is-scrolling')
      timers.delete(target)
    }, 900))
  }, true)
})()
/* Screen/system-audio recording. The host only owns state and file writes. */
let recorder = null
let captureStream = null
let recordChunks = []
const recordHost = window.lsaDesktop && window.lsaDesktop.host

function recordName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return '录音-' + stamp
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function startScreenRecording() {
  if (recorder) return
  try {
    captureStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: true })
    const audioTracks = captureStream.getAudioTracks()
    if (!audioTracks.length) throw new Error('没有捕获到系统声音')
    const audioStream = new MediaStream(audioTracks)
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    recordChunks = []
    recorder = new MediaRecorder(audioStream, { mimeType })
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) recordChunks.push(event.data) }
    recorder.onstop = async () => {
      try {
        const blob = new Blob(recordChunks, { type: mimeType })
        const data = await blobToBase64(blob)
        recordHost?.postMessage({ cmd: 'recordData', args: { name: recordName(), ext: 'webm', data } })
      } catch (error) {
        recordHost?.postMessage({ cmd: 'recordFail', args: { error: error.message } })
      } finally {
        captureStream?.getTracks().forEach((track) => track.stop())
        captureStream = null
        recorder = null
      }
    }
    recorder.start(1000)
  } catch (error) {
    captureStream?.getTracks().forEach((track) => track.stop())
    captureStream = null
    recorder = null
    recordHost?.postMessage({ cmd: 'recordFail', args: { error: error.message } })
  }
}

function stopScreenRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  else captureStream?.getTracks().forEach((track) => track.stop())
}

if (recordHost && recordHost.addEventListener) {
  recordHost.addEventListener('message', (event) => {
    const message = event && event.data ? event.data : event
    if (!message || !message.type) return
    if (message.type === 'record-start') startScreenRecording()
    if (message.type === 'record-stop') stopScreenRecording()
  })
}
