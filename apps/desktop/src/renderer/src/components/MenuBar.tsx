import { useEffect, useRef, useState } from 'react'

/**
 * Generieke menubalk (SAL-52) — professionele dropdown-menus zoals VS
 * Code/SSMS. De structuur is declaratief en uitbreidbaar (later Bewerken/
 * Beeld/Help etc. = gewoon een extra MenuDef).
 *
 * Gedrag:
 * - klik op een trigger opent/sluit het dropdown-menu; klik op een andere
 *   trigger wisselt;
 * - menu sluit bij buiten-klik en Escape;
 * - toetsenbordnavigatie binnen een geopend menu: Pijl ↓/↑ (+ Home/End),
 *   Enter/Spatie activeert, Pijl → opent een submenu, Pijl ← sluit het,
 *   Escape sluit eerst het submenu en daarna het hele menu.
 */

export interface MenuActionEntry {
  type: 'action'
  label: string
  /** Toetscombinatie rechts in het menu (alleen ter weergave). */
  shortcut?: string
  disabled?: boolean
  onSelect: () => void
}

export interface MenuSeparatorEntry {
  type: 'separator'
}

export interface MenuSubmenuEntry {
  type: 'submenu'
  label: string
  disabled?: boolean
  items: MenuEntry[]
}

export type MenuEntry = MenuActionEntry | MenuSeparatorEntry | MenuSubmenuEntry

export interface MenuDef {
  id: string
  label: string
  items: MenuEntry[]
}

interface MenuBarProps {
  menus: MenuDef[]
  /** Aria-label voor de menubalk (bijv. "Hoofdmenu"). */
  ariaLabel?: string
}

const isActionable = (entry: MenuEntry): entry is MenuActionEntry | MenuSubmenuEntry =>
  entry.type === 'action' || entry.type === 'submenu'

const isDisabled = (entry: MenuEntry): boolean =>
  (entry.type === 'action' || entry.type === 'submenu') && entry.disabled === true

export function MenuBar({ menus, ariaLabel = 'Hoofdmenu' }: MenuBarProps): React.JSX.Element {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Buiten-klik sluit elk geopend menu.
  useEffect(() => {
    if (!openMenuId) return
    const onMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [openMenuId])

  return (
    <div className="menu-bar" role="menubar" aria-label={ariaLabel} ref={rootRef}>
      {menus.map((menu) => {
        const isOpen = openMenuId === menu.id
        return (
          <div key={menu.id} className={`menu-trigger-wrap ${isOpen ? 'open' : ''}`}>
            <button
              type="button"
              className="menu-trigger"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => setOpenMenuId((cur) => (cur === menu.id ? null : menu.id))}
            >
              {menu.label}
            </button>
            {isOpen && (
              <DropdownMenu
                items={menu.items}
                onCloseAll={() => setOpenMenuId(null)}
                autoFocus
                depth={0}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

interface DropdownMenuProps {
  items: MenuEntry[]
  /** Sluit de volledige menubalk (na een actie). */
  onCloseAll: () => void
  /** Sluit dit (sub)menu en geeft focus terug aan de parent-trigger. */
  onBack?: () => void
  autoFocus?: boolean
  depth: number
}

function DropdownMenu({
  items,
  onCloseAll,
  onBack,
  autoFocus,
  depth
}: DropdownMenuProps): React.JSX.Element {
  const [openSub, setOpenSub] = useState<number | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Indexen van de aanklikbare regels (acties + submenu-triggers), in volgorde;
  // refs lopen hier parallel aan (separators/disabled tellen niet apart mee).
  const actionable: number[] = []
  items.forEach((entry, i) => {
    if (isActionable(entry)) actionable.push(i)
  })
  // item-index → positie in `itemRefs` (alleen aanklikbare regels hebben een ref).
  const refByItem = new Map<number, number>()
  actionable.forEach((itemIndex, refIdx) => refByItem.set(itemIndex, refIdx))

  useEffect(() => {
    if (!autoFocus) return
    const first = itemRefs.current.find((el) => el !== null && !el.disabled)
    first?.focus()
  }, [autoFocus])

  const focusMove = (from: number, delta: number): void => {
    const count = actionable.length
    if (count === 0) return
    let idx = from
    for (let step = 0; step < count; step++) {
      idx = (idx + delta + count) % count
      const el = itemRefs.current[idx]
      const entry = items[actionable[idx]!]!
      if (el && !isDisabled(entry)) {
        el.focus()
        return
      }
    }
  }

  const focusBoundary = (last: boolean): void => {
    const count = actionable.length
    for (let offset = 0; offset < count; offset++) {
      const i = last ? count - 1 - offset : offset
      const el = itemRefs.current[i]
      const entry = items[actionable[i]!]!
      if (el && !isDisabled(entry)) {
        el.focus()
        return
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent, idx: number): void => {
    const entry = items[actionable[idx]!]!
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusMove(idx, 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusMove(idx, -1)
        break
      case 'Home':
        e.preventDefault()
        focusBoundary(false)
        break
      case 'End':
        e.preventDefault()
        focusBoundary(true)
        break
      case 'ArrowRight':
        if (entry.type === 'submenu' && !entry.disabled) {
          e.preventDefault()
          setOpenSub(idx)
        }
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (openSub !== null && openSub !== idx) {
          setOpenSub(null)
          itemRefs.current[openSub]?.focus()
        } else if (openSub === null) {
          if (onBack) onBack()
          else onCloseAll()
        }
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (openSub !== null) {
          setOpenSub(null)
          itemRefs.current[openSub]?.focus()
        } else if (onBack) {
          onBack()
        } else {
          onCloseAll()
        }
        break
      case 'Tab':
        onCloseAll()
        break
    }
  }

  return (
    <div className="menu-panel" role="menu" data-depth={depth}>
      {items.map((entry, index) => {
        if (entry.type === 'separator') {
          return <div key={index} role="separator" className="menu-separator" />
        }
        const myIdx = refByItem.get(index) ?? -1
        const disabled = isDisabled(entry)
        if (entry.type === 'action') {
          return (
            <div key={index} className="menu-item-wrap">
              <button
                type="button"
                role="menuitem"
                aria-label={entry.label}
                className="menu-item"
                disabled={disabled}
                ref={(el) => {
                  itemRefs.current[myIdx] = el
                }}
                onClick={() => {
                  entry.onSelect()
                  onCloseAll()
                }}
                onKeyDown={(e) => handleKeyDown(e, myIdx)}
              >
                <span className="menu-item-label">{entry.label}</span>
                {entry.shortcut && <span className="menu-shortcut">{entry.shortcut}</span>}
              </button>
            </div>
          )
        }
        // submenu
        const isOpen = openSub === myIdx
        return (
          <div key={index} className="menu-item-wrap">
            <button
              type="button"
              role="menuitem"
              aria-label={entry.label}
              aria-haspopup="menu"
              aria-expanded={isOpen}
              className="menu-item menu-item-submenu"
              disabled={disabled}
              ref={(el) => {
                itemRefs.current[myIdx] = el
              }}
              onClick={() => setOpenSub((cur) => (cur === myIdx ? null : myIdx))}
              onMouseEnter={() => {
                if (openSub !== null) setOpenSub(myIdx)
              }}
              onKeyDown={(e) => handleKeyDown(e, myIdx)}
            >
              <span className="menu-item-label">{entry.label}</span>
              <span className="menu-caret" aria-hidden="true">
                ▸
              </span>
            </button>
            {isOpen && (
              <DropdownMenu
                items={entry.items}
                onCloseAll={onCloseAll}
                onBack={() => {
                  setOpenSub(null)
                  itemRefs.current[myIdx]?.focus()
                }}
                autoFocus
                depth={depth + 1}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
