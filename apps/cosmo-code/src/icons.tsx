// Cosmo Code's line icons (24×24, stroke = currentColor).
import type { JSX } from "solid-js"

const PATHS = {
  menu: "M4 7h16M4 12h16M4 17h16",
  sidebar: "M4 5h16v14H4zM9 5v14",
  back: "M19 12H5M11 6l-6 6 6 6",
  forward: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  briefcase: "M4 8h16v11H4zM9 8V5h6v3M4 13h16",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  moreVertical: "M12 6h.01M12 12h.01M12 18h.01",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-3.5-3.5",
  rail: "M4 5h16v14H4zM8 9h5M8 13h8M15 5v14",
  terminal: "M5 7l5 5-5 5M12 17h7",
  changes: "M6 4h12v16H6zM12 8v6M9 11h6M9 17h6",
  play: "M8 5v14l11-7z",
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  laptop: "M5 6h14v9H5zM3 18h18",
  branch: "M7 4v10M7 14a3 3 0 1 0 0 6a3 3 0 1 0 0-6M17 4a3 3 0 1 0 0 6a3 3 0 1 0 0-6M17 10c0 4-6 3-9 6",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M9 9h6v6H9z",
  check: "M5 12l5 5L20 7",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  fork: "M7 4v6a4 4 0 0 0 4 4h2a4 4 0 0 1 4 4v2M17 4v4M7 20v-4",
  pin: "M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v6",
  file: "M14 3H6v18h12V7zM14 3v4h4",
  close: "M6 6l12 12M18 6L6 18",
  ring: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v5M12 8h.01",
  comment: "M5 5h14v10H10l-5 4z",
  code: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  gear: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3a1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-6 6M4 20l6-6",
  collapse: "M20 4l-6 6M14 4v6h6M4 20l6-6M10 20v-6H4",
  list: "M4 6h16M4 12h16M4 18h10",
  rewind: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  keyboard: "M3 7h18v11H3zM7 11h.01M11 11h.01M15 11h.01M8 15h8",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9c-4-1.5-7-4.5-7-9V6z",
  gauge: "M4 17a8 8 0 1 1 16 0M12 17l4-6",
  monitor: "M3 5h18v11H3zM8 20h8M12 16v4",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  blocks: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  book: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11",
  sort: "M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3",
  pointer: "M5 3l6 16 2.5-6.5L20 10z",
  listChecks: "M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9",
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
