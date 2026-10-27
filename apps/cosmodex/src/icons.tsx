// Cosmodex's own line icons (24×24, stroke = currentColor).
import type { JSX } from "solid-js"

const PATHS = {
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2",
  plugins: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-4 7.5",
  explore: "M5 12h.01M12 12h.01M19 12h.01",
  gear: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3a1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-3.5-3.5",
  pencil: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  plus: "M12 5v14M5 12h14",
  chevronDown: "M6 9l6 6 6-6",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  sidebar: "M4 5h16v14H4zM9 5v14",
  hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-6.5V4.5a1.5 1.5 0 0 1 3 0V12m0-6a1.5 1.5 0 0 1 3 0v6m0-3.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-5-2.7L5 15.5a1.6 1.6 0 0 1 2.6-1.9L8 14",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  resume: "M8 5v14l11-7z",
  terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5",
  fileEdit: "M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h4",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  check: "M5 12l5 5L20 7",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  diff: "M12 4v8M8 8h8M8 17h8",
} as const

export type IconName = keyof typeof PATHS

export function Icon(props: { name: IconName; size?: number; class?: string } & JSX.AriaAttributes) {
  const size = () => props.size ?? 16
  return (
    <svg
      class={props.class}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props["aria-label"] ? undefined : "true"}
      aria-label={props["aria-label"]}
    >
      <path d={PATHS[props.name]} />
    </svg>
  )
}
