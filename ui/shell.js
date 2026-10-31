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
/* Draggable overlay scrollbar plus keyboard page jumps. No native rails. */
(() => {
  function scrollable(element) {
    if (!(element instanceof Element) || element === document.body || element === document.documentElement) return false
    if (element.scrollHeight <= element.clientHeight + 2) return false
    return /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY)
  }
  function scrollableUnder(node) {
    let element = node instanceof Element ? node : null
    while (element && element !== document.body) {
      if (scrollable(element)) return element
      element = element.parentElement
    }
    return null
  }
  const thumb = document.createElement('div')
  thumb.id = 'lsa-scroll-thumb'
  document.body.appendChild(thumb)
  let hideTimer = 0
  let active = null
  let dragging = false
  let dragStartY = 0
  let dragStartScroll = 0

  function update(target) {
    if (!target || target.scrollHeight <= target.clientHeight) {
      thumb.classList.remove('visible')
      active = null
      return
    }
    const rect = target.getBoundingClientRect()
    const track = Math.max(0, target.clientHeight - 8)
    const size = Math.max(26, Math.round(track * target.clientHeight / target.scrollHeight))
    const maxScroll = Math.max(1, target.scrollHeight - target.clientHeight)
    const top = rect.top + 4 + Math.round((track - size) * target.scrollTop / maxScroll)
    thumb.style.height = size + 'px'
    thumb.style.top = top + 'px'
    thumb.style.right = Math.max(3, window.innerWidth - rect.right + 3) + 'px'
    thumb.classList.add('visible')
    active = target
  }

  function hide() {
    if (dragging) return
    thumb.classList.remove('visible')
    active = null
  }

  function showFor(target) {
    if (!scrollable(target)) return
    clearTimeout(hideTimer)
    update(target)
    hideTimer = setTimeout(hide, 900)
  }

  document.addEventListener('scroll', (event) => {
    const target = event.target
    if (!scrollable(target)) return
    update(target)
    clearTimeout(hideTimer)
    if (!dragging) hideTimer = setTimeout(hide, 900)
  }, true)

  document.addEventListener('pointermove', (event) => {
    if (dragging) return
    const target = scrollableUnder(event.target)
    if (!target) return
    const rect = target.getBoundingClientRect()
    if (event.clientX >= rect.right - 14) showFor(target)
  }, { passive: true })

  document.addEventListener('pointerleave', (event) => {
    if (scrollableUnder(event.target)) {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(hide, 500)
    }
  }, true)

  thumb.addEventListener('pointerdown', (event) => {
    if (!active || active.scrollHeight <= active.clientHeight) return
    dragging = true
    dragStartY = event.clientY
    dragStartScroll = active.scrollTop
    thumb.classList.add('dragging')
    thumb.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  })
  thumb.addEventListener('pointermove', (event) => {
    if (!dragging || !active) return
    const maxScroll = Math.max(1, active.scrollHeight - active.clientHeight)
    const rect = active.getBoundingClientRect()
    const track = Math.max(1, rect.height - 8 - thumb.offsetHeight)
    active.scrollTop = dragStartScroll + (event.clientY - dragStartY) * maxScroll / track
  })
  const endDrag = () => {
    dragging = false
    thumb.classList.remove('dragging')
    hideTimer = setTimeout(hide, 700)
  }
  thumb.addEventListener('pointerup', endDrag)
  thumb.addEventListener('pointercancel', endDrag)

  document.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return
    const page = document.querySelector('.page.active')
    const target = (active && page && page.contains(active) ? active : null) || scrollableUnder(page) || scrollableUnder(document.querySelector('.main'))
    if (!target || target.scrollHeight <= target.clientHeight) return
    const pageStep = Math.max(240, target.clientHeight * 0.82)
    if (event.key === 'PageDown') { target.scrollBy({ top: pageStep, behavior: 'smooth' }); event.preventDefault() }
    if (event.key === 'PageUp') { target.scrollBy({ top: -pageStep, behavior: 'smooth' }); event.preventDefault() }
    if (event.key === 'End' && (event.ctrlKey || event.metaKey || !event.shiftKey)) { target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' }); event.preventDefault() }
    if (event.key === 'Home' && (event.ctrlKey || event.metaKey || !event.shiftKey)) { target.scrollTo({ top: 0, behavior: 'smooth' }); event.preventDefault() }
  })

  window.addEventListener('resize', () => {
    if (active) update(active)
    else hide()
  }, { passive: true })
})()



