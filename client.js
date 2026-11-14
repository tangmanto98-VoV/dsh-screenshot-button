/**
 * Screenshot button — browser half.
 *
 * A camera control in the composer's activity seat. It captures one chosen
 * monitor (or every screen when asked), wraps the answer in a `File`, and hands
 * it to the app's own document-level paste intake, so the image lands in the
 * draft attachment rail exactly as if it had been pasted from the clipboard.
 * The chosen screen is remembered, so the common case stays one click.
 */
window.__ModuleLoader__.load({
  id: 'dsh-screenshot-button',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-screenshot-button'
    const CAPTURE_PATH = '/dsh-screenshot/capture'
    const MONITORS_PATH = '/dsh-screenshot/monitors'
    const LOG_PATH = '/dsh-screenshot/client-log'
    const STORAGE_KEY = 'dsh-screenshot-button:target'

    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    const FALLBACK = {
      title: '\u622a\u5c4f',
      busy: '\u6b63\u5728\u622a\u5c4f\u2026',
      failed: '\u622a\u56fe\u5931\u8d25',
      choose: '\u9009\u62e9\u8981\u622a\u7684\u5c4f\u5e55',
      allScreens: '\u5168\u90e8\u5c4f\u5e55',
      screen: '\u5c4f\u5e55',
      primary: '\u4e3b\u5c4f',
      loading: '\u6b63\u5728\u8bfb\u53d6\u5c4f\u5e55\u2026',
      change: '\u66f4\u6362\u5c4f\u5e55\uff08\u53f3\u952e\u6216\u70b9\u7bad\u5934\uff09',
    }

    /** Resolve a Host route against the directory the page is served from. */
    function route(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined') return path
      try {
        return new URL(relative, document.baseURI).pathname
      } catch {
        return path
      }
    }

    /** Best-effort diagnostics; the Host appends them to its log file. */
    function report(message) {
      try {
        const query = new URLSearchParams({ message: String(message).slice(0, 700) })
        fetch(`${route(LOG_PATH)}?${query.toString()}`, { cache: 'no-store' }).catch(() => {})
      } catch {
        // Diagnostics must never break the button.
      }
    }

    function readStoredTarget() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (raw === null) return null
        if (raw === 'all') return 'all'
        const index = Number.parseInt(raw, 10)
        return Number.isFinite(index) && index >= 0 ? index : null
      } catch {
        return null
      }
    }

    function writeStoredTarget(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, String(value))
      } catch {
        // A blocked storage area only costs the remembered choice.
      }
    }

    function decodeBase64(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff
      return bytes
    }

    function fileName(mediaType) {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      const extension = mediaType === 'image/jpeg' ? 'jpg' : 'png'
      return `screenshot-${stamp}.${extension}`
    }

    async function listMonitors() {
      const response = await fetch(route(MONITORS_PATH), { cache: 'no-store', credentials: 'same-origin' })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`)
      }
      if (payload === null || payload.ok !== true) {
        throw new Error(payload && payload.error ? String(payload.error) : `HTTP ${response.status}`)
      }
      const monitors = Array.isArray(payload.monitors) ? payload.monitors.slice() : []
      // Number the rows left to right, which is how the screens are laid out;
      // `index` keeps the Host's own enumeration order for the capture call.
      monitors.sort((left, right) => left.x - right.x)
      return monitors
    }

    /** Ask the Host for a capture and deliver it to the composer's intake. */
    async function attachScreenshot(target) {
      const query = new URLSearchParams({ target: String(target) })
      const response = await fetch(`${route(CAPTURE_PATH)}?${query.toString()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
      }
      if (payload === null || payload.ok !== true) {
        throw new Error(payload && payload.error ? String(payload.error) : `HTTP ${response.status}`)
      }
      const mediaType = typeof payload.mediaType === 'string' ? payload.mediaType : 'image/png'
      const bytes = decodeBase64(String(payload.base64 ?? ''))
      const file = new File([bytes], fileName(mediaType), { type: mediaType })

      const transfer = new DataTransfer()
      transfer.items.add(file)
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      if (event.clipboardData !== transfer) {
        try {
          Object.defineProperty(event, 'clipboardData', { value: transfer, configurable: true })
        } catch {
          // Older engines may refuse the override; the constructor form still applies.
        }
      }
      document.dispatchEvent(event)
      return { bytes: bytes.length, mediaType }
    }

    function cameraIcon(phase) {
      if (phase === 'capturing') {
        return h(
          'svg',
          {
            viewBox: '0 0 18 18',
            width: 18,
            height: 18,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            'aria-hidden': true,
          },
          h(
            'g',
            null,
            h('path', { d: 'M9 2.6a6.4 6.4 0 1 1-6.4 6.4' }),
            h('animateTransform', {
              attributeName: 'transform',
              type: 'rotate',
              from: '0 9 9',
              to: '360 9 9',
              dur: '0.9s',
              repeatCount: 'indefinite',
            }),
          ),
        )
      }
      return h(
        'svg',
        {
          viewBox: '0 0 18 18',
          width: 18,
          height: 18,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', {
          d: 'M2.7 6.6h2.1l1.2-1.9h4l1.2 1.9h2.1a1.2 1.2 0 0 1 1.2 1.2v4.8a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2V7.8a1.2 1.2 0 0 1 1.2-1.2Z',
        }),
        h('circle', { cx: 9, cy: 10.4, r: 2.15 }),
      )
    }

    function MenuRow(props) {
      const [hovered, setHovered] = React.useState(false)
      const active = props.active === true
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': active,
          onClick: props.onSelect,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '7px 10px',
            border: 0,
            borderRadius: '7px',
            textAlign: 'left',
            font: 'inherit',
            fontSize: '12.5px',
            lineHeight: 1.35,
            cursor: 'pointer',
            background: hovered ? 'rgba(127, 127, 127, 0.16)' : 'transparent',
            color: 'inherit',
          },
        },
        h(
          'span',
          { style: { width: '14px', flex: '0 0 14px', opacity: active ? 1 : 0, color: '#2f7fd1' }, 'aria-hidden': true },
          '\u2713',
        ),
        h('span', { style: { flex: '1 1 auto' } }, props.label),
        props.hint === undefined
          ? null
          : h('span', { style: { opacity: 0.55, fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' } }, props.hint),
      )
    }

    function ScreenshotButton(props) {
      const { t, locked, onActiveChange } = props
      const [phase, setPhase] = React.useState('idle')
      const [hovered, setHovered] = React.useState(false)
      const [error, setError] = React.useState('')
      const [target, setTarget] = React.useState(readStoredTarget)
      const [menu, setMenu] = React.useState(null)
      const [monitors, setMonitors] = React.useState(null)
      const [menuError, setMenuError] = React.useState('')
      const buttonRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      React.useLayoutEffect(() => {
        if (typeof onActiveChange !== 'function') return undefined
        onActiveChange(false)
        return () => {
          onActiveChange(false)
        }
      }, [onActiveChange])

      React.useEffect(() => {
        if (menu === null) return undefined
        const onPointerDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          if (buttonRef.current !== null && buttonRef.current.contains(event.target)) return
          setMenu(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [menu])

      const string = (key) => {
        if (typeof t === 'function') {
          try {
            const value = t(key)
            if (typeof value === 'string' && value !== '' && value !== key && value !== `${NS}.${key}`) return value
          } catch {
            // Fall through to the built-in copy.
          }
        }
        return FALLBACK[key] ?? key
      }

      const disabled = locked === true || phase === 'capturing'

      const capture = (next) => {
        if (disabled) return
        setMenu(null)
        setPhase('capturing')
        setError('')
        attachScreenshot(next)
          .then((result) => {
            report(`attached target=${String(next)} ${result.mediaType} ${result.bytes} bytes`)
            if (!alive.current) return
            setPhase('done')
            window.setTimeout(() => {
              if (alive.current) setPhase('idle')
            }, 900)
          })
          .catch((failure) => {
            const message = String(failure && failure.message ? failure.message : failure)
            report(`failed target=${String(next)} ${message}`)
            if (!alive.current) return
            setError(message)
            setPhase('error')
            window.setTimeout(() => {
              if (alive.current) setPhase('idle')
            }, 5000)
          })
      }

      const openMenu = () => {
        if (disabled) return
        const rect = buttonRef.current === null ? null : buttonRef.current.getBoundingClientRect()
        if (rect !== null) {
          setMenu({
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
            right: Math.max(8, window.innerWidth - rect.right),
          })
        }
        setMenuError('')
        if (monitors === null) {
          listMonitors()
            .then((list) => {
              if (alive.current) setMonitors(list)
            })
            .catch((failure) => {
              const message = String(failure && failure.message ? failure.message : failure)
              report(`monitors failed ${message}`)
              if (!alive.current) return
              setMonitors([])
              setMenuError(message)
            })
        }
      }

      const choose = (next) => {
        writeStoredTarget(next)
        setTarget(next)
        capture(next)
      }

      const onPrimary = () => {
        if (target === null) {
          openMenu()
          return
        }
        capture(target)
      }

      const label =
        phase === 'capturing' ? string('busy') : phase === 'error' ? string('failed') : `${string('title')} · ${string('change')}`

      const tint = phase === 'error' ? '#e5484d' : phase === 'done' ? '#1f9d55' : 'inherit'

      const buttonStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '28px',
        padding: 0,
        border: 0,
        borderRadius: '8px',
        background: 'transparent',
        color: tint,
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'opacity 120ms ease, background-color 120ms ease',
      }

      const menuNode =
        menu === null
          ? null
          : h(
              'div',
              {
                ref: menuRef,
                role: 'menu',
                'aria-label': string('choose'),
                style: {
                  position: 'fixed',
                  bottom: `${menu.bottom}px`,
                  right: `${menu.right}px`,
                  zIndex: 2147483000,
                  minWidth: '212px',
                  padding: '6px',
                  borderRadius: '11px',
                  border: '1px solid rgba(127, 127, 127, 0.28)',
                  background: 'rgba(28, 28, 32, 0.97)',
                  color: '#f2f2f4',
                  boxShadow: '0 12px 34px rgba(0, 0, 0, 0.4)',
                  font: 'inherit',
                  backdropFilter: 'blur(12px)',
                },
              },
              [
                h(
                  'div',
                  {
                    key: 'header',
                    style: {
                      padding: '4px 10px 7px',
                      fontSize: '11px',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      opacity: 0.55,
                    },
                  },
                  string('choose'),
                ),
                monitors === null
                  ? h(
                      'div',
                      { key: 'loading', style: { padding: '7px 10px', fontSize: '12.5px', opacity: 0.7 } },
                      string('loading'),
                    )
                  : null,
                monitors === null
                  ? null
                  : h(
                      MenuRow,
                      {
                        key: 'all',
                        label: string('allScreens'),
                        active: target === 'all',
                        onSelect: () => choose('all'),
                      },
                    ),
                monitors === null
                  ? null
                  : monitors.map((monitor, position) =>
                      h(MenuRow, {
                        key: `m${String(monitor.index)}`,
                        label: `${string('screen')} ${position + 1}${monitor.primary === true ? ` · ${string('primary')}` : ''}`,
                        hint: `${monitor.width}\u00d7${monitor.height}`,
                        active: target === monitor.index,
                        onSelect: () => choose(monitor.index),
                      }),
                    ),
                menuError === ''
                  ? null
                  : h(
                      'div',
                      {
                        key: 'error',
                        style: { padding: '6px 10px', fontSize: '11.5px', color: '#ff9ea2', wordBreak: 'break-word' },
                      },
                      menuError.slice(0, 200),
                    ),
              ],
            )

      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        phase === 'error' && error !== ''
          ? h(
              'span',
              {
                role: 'status',
                style: {
                  position: 'absolute',
                  bottom: 'calc(100% + 8px)',
                  right: 0,
                  maxWidth: '320px',
                  padding: '6px 9px',
                  borderRadius: '8px',
                  background: 'rgba(24, 24, 27, 0.94)',
                  color: '#f4f4f5',
                  fontSize: '12px',
                  lineHeight: 1.4,
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
                  zIndex: 2,
                },
              },
              error,
            )
          : null,
        h(
          'span',
          {
            ref: buttonRef,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              borderRadius: '8px',
              background: hovered && !disabled ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
              transition: 'background-color 120ms ease',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-label': label,
              'aria-haspopup': 'menu',
              'aria-expanded': menu !== null,
              title: label,
              disabled,
              onClick: onPrimary,
              onContextMenu: (event) => {
                event.preventDefault()
                openMenu()
              },
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
              style: { ...buttonStyle, width: '27px', opacity: hovered && !disabled ? 1 : buttonStyle.opacity * 0.72 },
            },
            cameraIcon(phase),
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-label': string('choose'),
              title: string('choose'),
              disabled,
              onClick: openMenu,
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
              style: { ...buttonStyle, width: '12px', opacity: disabled ? 0.3 : 0.55 },
            },
            h(
              'svg',
              {
                viewBox: '0 0 6 10',
                width: 6,
                height: 10,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true,
              },
              h('path', { d: 'M1 1.5 4.5 5 1 8.5' }),
            ),
          ),
        ),
        menuNode === null || ReactDOM === null || typeof ReactDOM.createPortal !== 'function'
          ? menuNode
          : ReactDOM.createPortal(menuNode, document.body),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.activity',
              locale: NS,
            },
            ScreenshotButton,
          ),
        )
      },
    }
  },
})
