/* Custom select: native popups are OS-drawn (blue, square) and cannot be themed. */
(function () {
  const selects = Array.from(document.querySelectorAll('select'))
  if (!selects.length) return

  const instances = new Map()

  function optionLabel(select) {
    return select.options[select.selectedIndex]?.textContent || ''
  }

  function closeAll(except) {
    for (const instance of instances.values()) {
      if (instance !== except) instance.close()
    }
  }

  function enhance(select) {
    const wrapper = document.createElement('div')
    wrapper.className = 'custom-select'
    select.parentNode.insertBefore(wrapper, select)
    wrapper.appendChild(select)
    select.classList.add('native-select')
    select.setAttribute('tabindex', '-1')

    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'custom-select-trigger'
    trigger.setAttribute('role', 'combobox')
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.innerHTML = '<span class="custom-select-value"></span><span class="custom-select-chevron" aria-hidden="true"></span>'
    const menu = document.createElement('div')
    menu.className = 'custom-select-menu hidden'
    menu.setAttribute('role', 'listbox')
    menu.id = 'custom-select-' + select.id
    trigger.setAttribute('aria-controls', menu.id)
    wrapper.append(trigger, menu)

    const value = trigger.querySelector('.custom-select-value')
    let open = false

    const sync = () => {
      const label = optionLabel(select)
      value.textContent = label
      trigger.setAttribute('aria-label', (select.labels?.[0]?.textContent || select.id) + '：' + label)
      menu.querySelectorAll('[role="option"]').forEach((option, index) => {
        const selected = index === select.selectedIndex
        option.setAttribute('aria-selected', selected ? 'true' : 'false')
        option.classList.toggle('selected', selected)
      })
    }

    const render = () => {
      menu.innerHTML = Array.from(select.options).map((option, index) =>
        '<div class="custom-select-option' + (index === select.selectedIndex ? ' selected' : '') + '" role="option" data-index="' + index + '" aria-selected="' + (index === select.selectedIndex) + '">' + option.textContent + '</div>'
      ).join('')
    }

    const close = () => {
      open = false
      trigger.setAttribute('aria-expanded', 'false')
      menu.classList.add('hidden')
    }
    const openMenu = () => {
      closeAll()
      sync()
      const rect = trigger.getBoundingClientRect()
      menu.classList.remove('hidden')
      if (rect.bottom + menu.offsetHeight > window.innerHeight - 8) menu.style.bottom = 'calc(100% + 5px)'
      else menu.style.bottom = ''
      open = true
      trigger.setAttribute('aria-expanded', 'true')
      const selected = menu.querySelector('[aria-selected="true"]')
      selected?.scrollIntoView({ block: 'nearest' })
    }

    trigger.addEventListener('click', () => { open ? close() : openMenu() })
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)))
        select.selectedIndex = next
        sync()
        select.dispatchEvent(new Event('change', { bubbles: true }))
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); open ? close() : openMenu()
      } else if (event.key === 'Escape') {
        close()
      }
    })
    trigger.addEventListener('pointerenter', sync)

    menu.addEventListener('click', (event) => {
      const option = event.target.closest('[role="option"]')
      if (!option) return
      select.selectedIndex = Number(option.dataset.index)
      sync()
      select.dispatchEvent(new Event('change', { bubbles: true }))
      close()
      trigger.focus()
    })
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { close(); trigger.focus() }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const option = menu.querySelector('[aria-selected="true"]')
        if (option) option.click()
      }
    })
    select.addEventListener('change', sync)
    document.addEventListener('pointerdown', (event) => { if (!wrapper.contains(event.target)) close() })

    instances.set(select, { close, sync })
    render()
    sync()
  }

  selects.forEach(enhance)
})();
