/* ── typediff docs — vanilla JS ── */

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches

setupScrollReveals()
setupTerminalTyping()
setupPipelineAnimation()
setupAccuracyCounters()
setupDividerSweep()
setupCopyButtons()
setupMobileNav()
setupDocsSidebar()

/* ── Scroll reveal system ── */

function setupScrollReveals() {
  if (typeof IntersectionObserver === 'undefined') return

  document.body.classList.add('js-reveal')

  if (REDUCED_MOTION) {
    for (const el of document.querySelectorAll('.reveal')) {
      el.classList.add('is-visible')
    }
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const el = entry.target
        el.classList.add('is-visible')
        observer.unobserve(el)

        // Stagger children with .reveal-child class
        const children = el.querySelectorAll('.reveal-child')
        children.forEach((child, i) => {
          setTimeout(() => child.classList.add('is-visible'), i * 100)
        })
      }
    },
    { threshold: 0.1, rootMargin: '0px 0px 100px 0px' },
  )

  for (const el of document.querySelectorAll('.reveal')) {
    observer.observe(el)
  }
}

/* ── Terminal typing animation ── */

function setupTerminalTyping() {
  const terminal = document.getElementById('terminal-demo')
  if (!terminal || terminal.dataset.typed) return

  const groups = Array.from(terminal.querySelectorAll('[data-reveal-group]'))
  if (groups.length === 0) return

  terminal.dataset.typed = 'true'

  if (REDUCED_MOTION) {
    for (const g of groups) g.classList.add('is-revealed')
    return
  }

  const terminalEl = terminal.closest('.terminal')
  const ctaButtons = document.querySelector('.hero-actions')
  const mismatchGroup = terminal.querySelector('[data-reveal-group="4"]')

  // Hide CTA buttons immediately (before scheduling timeouts to avoid flash)
  if (ctaButtons) {
    ctaButtons.style.opacity = '0'
  }

  // Timing for each of the 11 groups (ms delay before reveal)
  // Group 1 types char-by-char (~900ms), so subsequent groups start later
  const timings = [600, 1600, 1800, 2000, 2400, 2800, 3000, 3200, 3400, 3900, 4200]

  groups.forEach((group, i) => {
    const delay = timings[i] || (timings[timings.length - 1] + (i - timings.length + 1) * 200)

    setTimeout(() => {
      // Group 1: type character by character for forensic terminal feel
      if (i === 0) {
        typeChars(group, 30)
        return
      }

      group.classList.add('is-revealed')

      // Flash terminal border on MISMATCH reveal
      if (group === mismatchGroup && terminalEl) {
        terminalEl.classList.add('is-flash')
        const mismatchSpan = group.querySelector('.t-mismatch')
        if (mismatchSpan) mismatchSpan.classList.add('t-mismatch-glow')
        setTimeout(() => {
          terminalEl.classList.remove('is-flash')
          terminalEl.classList.add('is-flash-off')
          setTimeout(() => terminalEl.classList.remove('is-flash-off'), 400)
        }, 400)
      }

      // Callback on last group — fade in CTA buttons
      if (i === groups.length - 1 && ctaButtons) {
        setTimeout(() => {
          ctaButtons.style.transition = 'opacity 400ms ease'
          ctaButtons.style.opacity = '1'
        }, 300)
      }
    }, delay)
  })
}

function typeChars(group, charDelay) {
  // Save the original child nodes (safe — these are our own static HTML nodes, not user content)
  const savedNodes = Array.from(group.childNodes).map(n => n.cloneNode(true))
  const textContent = group.textContent || ''

  // Clear and make visible
  while (group.firstChild) group.removeChild(group.firstChild)
  group.style.visibility = 'visible'
  group.style.opacity = '1'

  // Add a typing cursor
  const cursor = document.createElement('span')
  cursor.className = 'terminal-cursor'
  group.appendChild(cursor)

  // Type out plain text char by char, then swap in the styled HTML
  const textNode = document.createTextNode('')
  group.insertBefore(textNode, cursor)

  let i = 0
  function tick() {
    if (i < textContent.length) {
      textNode.textContent = textContent.slice(0, i + 1)
      i++
      setTimeout(tick, charDelay)
    } else {
      // Restore the original styled nodes
      while (group.firstChild) group.removeChild(group.firstChild)
      for (const node of savedNodes) group.appendChild(node)
      group.classList.add('is-revealed')
    }
  }
  tick()
}

/* ── Pipeline scroll animation ── */

function setupPipelineAnimation() {
  const pipeline = document.querySelector('.pipeline')
  if (!pipeline) return

  const nodes = Array.from(pipeline.querySelectorAll('.pipeline-node-dot'))
  const labels = Array.from(pipeline.querySelectorAll('.pipeline-node-label'))
  const descs = Array.from(pipeline.querySelectorAll('.pipeline-node-desc'))
  const edges = Array.from(pipeline.querySelectorAll('.pipeline-edge'))

  // Set initial dim state
  for (const n of nodes) n.classList.add('is-dim')
  for (const l of labels) l.classList.add('is-dim')
  for (const d of descs) d.classList.add('is-dim')
  for (const e of edges) e.classList.add('is-dim')

  if (REDUCED_MOTION) {
    for (const n of nodes) { n.classList.remove('is-dim'); n.classList.add('is-lit') }
    for (const l of labels) { l.classList.remove('is-dim'); l.classList.add('is-lit') }
    for (const d of descs) { d.classList.remove('is-dim'); d.classList.add('is-lit') }
    for (const e of edges) { e.classList.remove('is-dim'); e.classList.add('is-lit') }
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer.unobserve(entry.target)
        animatePipeline(nodes, labels, descs, edges)
      }
    },
    { threshold: 0.3 },
  )

  observer.observe(pipeline)
}

function animatePipeline(nodes, labels, descs, edges) {
  let delay = 0

  for (let i = 0; i < nodes.length; i++) {
    // Light up node
    setTimeout(() => {
      nodes[i].classList.remove('is-dim')
      nodes[i].classList.add('is-lit')
      labels[i].classList.remove('is-dim')
      labels[i].classList.add('is-lit')
      descs[i].classList.remove('is-dim')
      descs[i].classList.add('is-lit')

      // Node 4 (index 3) gets emphasis
      if (i === 3) nodes[i].classList.add('is-emphasis')
    }, delay)

    delay += 300

    // Light up edge after node (except after last node)
    if (i < edges.length) {
      setTimeout(() => {
        edges[i].classList.remove('is-dim')
        edges[i].classList.add('is-lit')
      }, delay)

      delay += 250
    }
  }
}

/* ── Accuracy counter animation ── */

function setupAccuracyCounters() {
  const summary = document.querySelector('.accuracy-summary')
  if (!summary) return

  const table = document.querySelector('.accuracy-table')
  if (!table) return

  // Compute values from the table
  const totalRows = table.querySelectorAll('tbody tr').length
  const breakingRows = table.querySelectorAll('tbody .badge-breaking').length
  const falsePositives = 0

  const counters = summary.querySelectorAll('.counter')
  if (counters.length >= 3) {
    counters[0].dataset.countTo = String(totalRows)
    counters[1].dataset.countTo = String(falsePositives)
    counters[2].dataset.countTo = String(breakingRows)
  }

  if (REDUCED_MOTION) {
    for (const c of counters) c.textContent = c.dataset.countTo
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer.unobserve(entry.target)
        for (const counter of counters) {
          countUp(counter, parseInt(counter.dataset.countTo, 10), 1000)
        }
      }
    },
    { threshold: 0.5 },
  )

  observer.observe(summary)
}

function countUp(el, target, duration) {
  if (target === 0) { el.textContent = '0'; return }

  const start = performance.now()

  function tick(now) {
    const elapsed = now - start
    const progress = Math.min(elapsed / duration, 1)
    const eased = 1 - Math.pow(1 - progress, 3) // ease-out cubic
    el.textContent = String(Math.round(eased * target))
    if (progress < 1) requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

/* ── Divider sweep animation (disabled) ── */

function setupDividerSweep() {}

/* ── Copy buttons on code blocks ── */

function setupCopyButtons() {
  // Inline copy buttons with data-copy attribute
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const text = button.getAttribute('data-copy')
      if (text) await copyText(button, text)
    })
  }

  // Add copy buttons to all code blocks
  for (const block of document.querySelectorAll('.code-block')) {
    const code = block.querySelector('code')
    if (!code) continue

    const btn = document.createElement('button')
    btn.className = 'copy-btn'
    btn.textContent = 'Copy'
    block.appendChild(btn)

    btn.addEventListener('click', async () => {
      const text = code.textContent || ''
      await copyText(btn, text)
    })
  }
}

async function copyText(button, text) {
  const original = button.textContent
  try {
    await navigator.clipboard.writeText(text.trim())
    button.textContent = 'Copied!'
  } catch {
    button.textContent = 'Failed'
  }
  setTimeout(() => { button.textContent = original }, 1400)
}

/* ── Mobile nav toggle ── */

function setupMobileNav() {
  const toggle = document.getElementById('nav-toggle')
  const links = document.getElementById('topbar-links')
  if (!toggle || !links) return

  toggle.addEventListener('click', () => {
    links.classList.toggle('is-open')
    toggle.textContent = links.classList.contains('is-open') ? 'Close' : 'Menu'
  })

  // Close when a link is clicked
  for (const link of links.querySelectorAll('a')) {
    link.addEventListener('click', () => {
      links.classList.remove('is-open')
      toggle.textContent = 'Menu'
    })
  }
}

/* ── Docs sidebar active link on scroll ── */

function setupDocsSidebar() {
  const nav = document.querySelector('.docs-nav')
  if (!nav) return

  const links = Array.from(nav.querySelectorAll('a[href^="#"]'))
  const targets = links
    .map(link => ({
      link,
      target: document.getElementById(link.getAttribute('href').slice(1)),
    }))
    .filter(entry => entry.target)

  if (targets.length === 0) return

  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          for (const { link } of targets) link.classList.remove('is-active')
          const match = targets.find(t => t.target === entry.target)
          if (match) match.link.classList.add('is-active')
        }
      }
    },
    { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
  )

  for (const { target } of targets) observer.observe(target)

  // Mobile sidebar toggle
  const sidebar = document.querySelector('.docs-sidebar')
  const sidebarToggle = document.getElementById('sidebar-toggle')
  if (sidebar && sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('is-open')
      sidebarToggle.textContent = sidebar.classList.contains('is-open') ? 'Hide Nav' : 'Show Nav'
    })

    // Close sidebar on link click (mobile)
    for (const link of links) {
      link.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('is-open')
          sidebarToggle.textContent = 'Show Nav'
        }
      })
    }
  }
}
