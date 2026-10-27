// A minimal anchored popover/menu: opens below (or above) its trigger, closes on outside click
// and Escape. Menus are lists of items with optional subtitle, shortcut, check and lock.
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
    <div class="cx-popover-anchor" ref={root}>
      {props.trigger(open, () => setOpen((v) => !v))}
      <Show when={open()}>
        <div
          class={`cx-popover ${props.class ?? ""}`}
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
      disabled?: boolean
      locked?: string
      onSelect?: () => void
    }

export function MenuList(props: { items: MenuItem[]; close: () => void }) {
  return (
    <ul class="cx-menu">
      <For each={props.items}>
        {(item) =>
          "separator" in item ? (
            <li class="cx-menu-sep" role="separator" />
          ) : "heading" in item ? (
            <li class="cx-menu-heading">{item.heading}</li>
          ) : (
            <li>
              <button
                class="cx-menu-item"
                role="menuitem"
                disabled={item.disabled || !!item.locked}
                data-locked={item.locked ? "" : undefined}
                onClick={() => {
                  item.onSelect?.()
                  props.close()
                }}
              >
                <span class="cx-menu-text">
                  <span class="cx-menu-label">{item.label}</span>
                  <Show when={item.locked ?? item.subtitle}>
                    <span class="cx-menu-subtitle">{item.locked ?? item.subtitle}</span>
                  </Show>
                </span>
                <Show when={item.shortcut}>
                  <kbd class="cx-menu-kbd">{item.shortcut}</kbd>
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
