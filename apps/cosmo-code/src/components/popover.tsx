// A minimal anchored popover/menu: opens below (or above) its trigger, closes on outside click
// and Escape. Menus are lists of items with optional subtitle, shortcut, check, lock and submenu
// (opens on hover, click or →; ← and Escape close it).
import { createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { Icon } from "../icons"

export function Popover(props: {
  trigger: (open: () => boolean, toggle: () => void) => JSX.Element
  children: (close: () => void) => JSX.Element
  placement?: "below" | "above"
  align?: "start" | "end"
  class?: string
}) {
  const [open, setOpen] = createSignal(false)
  let root!: HTMLDivElement
  const close = () => setOpen(false)
  const onDoc = (e: MouseEvent) => {
    if (open() && !root.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (open() && e.key === "Escape") close()
  }
  document.addEventListener("mousedown", onDoc)
  document.addEventListener("keydown", onKey)
  onCleanup(() => {
    document.removeEventListener("mousedown", onDoc)
    document.removeEventListener("keydown", onKey)
  })
  return (
    <div class="cc-popover-anchor" ref={root}>
      {props.trigger(open, () => setOpen((v) => !v))}
      <Show when={open()}>
        <div
          class={`cc-popover ${props.class ?? ""}`}
          data-placement={props.placement ?? "below"}
          data-align={props.align ?? "start"}
          role="menu"
        >
          {props.children(close)}
        </div>
      </Show>
    </div>
  )
}

export type MenuItem =
  | { separator: true }
  | { heading: string }
  | {
      label: string
      subtitle?: string
      shortcut?: string
      checked?: boolean
      /** A check item (role menuitemcheckbox) even while unchecked. */
      checkable?: boolean
      disabled?: boolean
      submenu?: MenuItem[]
      locked?: string
      onSelect?: () => void
    }

export function MenuList(props: { items: MenuItem[]; close: () => void }) {
  return (
    <ul class="cc-menu">
      <For each={props.items}>
        {(item) =>
          "separator" in item ? (
            <li class="cc-menu-sep" role="separator" />
          ) : "heading" in item ? (
            <li class="cc-menu-heading">{item.heading}</li>
          ) : item.submenu ? (
            <SubmenuItem label={item.label} items={item.submenu} close={props.close} />
          ) : (
            <li>
              <button
                class="cc-menu-item"
                role={item.checkable || item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
                aria-checked={item.checkable || item.checked !== undefined ? !!item.checked : undefined}
                aria-keyshortcuts={item.shortcut?.includes("+") ? item.shortcut.replace("Ctrl", "Control") : undefined}
                disabled={item.disabled || !!item.locked}
                data-locked={item.locked ? "" : undefined}
                onClick={() => {
                  item.onSelect?.()
                  props.close()
                }}
              >
                <span class="cc-menu-text">
                  <span class="cc-menu-label">{item.label}</span>
                  <Show when={item.locked ?? item.subtitle}>
                    <span class="cc-menu-subtitle">{item.locked ?? item.subtitle}</span>
                  </Show>
                </span>
                <Show when={item.shortcut}>
                  <kbd class="cc-menu-kbd">{item.shortcut}</kbd>
                </Show>
                <Show when={item.checked}>
                  <Icon name="check" size={14} />
                </Show>
                <Show when={item.locked}>
                  <Icon name="lock" size={14} />
                </Show>
              </button>
            </li>
          )
        }
      </For>
    </ul>
  )
}

function SubmenuItem(props: { label: string; items: MenuItem[]; close: () => void }) {
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  return (
    <li class="cc-submenu-anchor" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        ref={button}
        class="cc-menu-item"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault()
            setOpen(true)
            queueMicrotask(() => (button.nextElementSibling?.querySelector("button:not(:disabled)") as HTMLElement | null)?.focus())
          }
        }}
      >
        <span class="cc-menu-text">
          <span class="cc-menu-label">{props.label}</span>
        </span>
        <Icon name="chevronRight" size={14} />
      </button>
      <Show when={open()}>
        <div
          class="cc-popover cc-submenu"
          role="menu"
          aria-label={props.label}
          // Fixed to the viewport, beside its item (scrolling containers such as the sidebar would clip
          // it), and kept on screen.
          ref={(el) =>
            queueMicrotask(() => {
              const at = button.getBoundingClientRect()
              // Touching the item, so the pointer can cross over without leaving it.
              const right = at.right + el.offsetWidth <= window.innerWidth
              el.style.left = `${right ? at.right - 1 : Math.max(4, at.left - el.offsetWidth + 1)}px`
              el.style.top = `${Math.max(4, Math.min(at.top - 5, window.innerHeight - el.offsetHeight - 4))}px`
            })
          }
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "Escape") return
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
            button.focus()
          }}
        >
          <MenuList items={props.items} close={props.close} />
        </div>
      </Show>
    </li>
  )
}
