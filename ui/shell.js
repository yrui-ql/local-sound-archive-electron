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
