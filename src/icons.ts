// Inline 16×16 icons, all currentColor, no dependencies. Static chrome gets them via
// [data-icon] hydration at boot; markup generated in JS (layer eyes, compile button)
// interpolates ICONS directly.
const S = (inner: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const F = (inner: string) => `<svg viewBox="0 0 16 16" fill="currentColor" stroke="none">${inner}</svg>`;

export const ICONS: Record<string, string> = {
  // floor-plan: outer wall + partition lines
  logo: S(`<path d="M2 2h12v12H2z"/><path d="M2 8.4h6.4M8.4 8.4V14M8.4 8.4H14"/>`),
  // cursor arrow (filled reads better at 16px)
  select: F(`<path d="M5 1.7c-.2 0-.4.2-.3.5l1.6 11c.1.4.6.4.8.1l2.1-3.5 3.9-.8c.4-.1.5-.6.1-.8L5.3 1.8c-.1-.1-.2-.1-.3-.1z"/>`),
  hand: S(
    `<path d="M5.2 7.4V4.1a.9.9 0 0 1 1.8 0v3.1M7 6.8V2.9a.9.9 0 0 1 1.8 0v3.9M8.8 7V3.9a.9.9 0 0 1 1.8 0v4.2M10.6 8.1l1.4-1.5a.9.9 0 0 1 1.3 1.2l-2.2 2.9c-.9 1.1-1.8 1.9-3.6 1.9-2.1 0-3-.9-3.8-2.3l-1.1-1.9a.85.85 0 0 1 1.4-.9l1.2 1.4"/>`,
  ),
  place: S(`<rect x="2" y="2" width="12" height="12" stroke-dasharray="2.6 2.2"/><path d="M8 5v6M5 8h6"/>`),
  note: S(`<path d="M2.5 2.8h11v8.6H9.2L6 14v-2.6H2.5z"/>`),
  undo: S(`<path d="M6.3 3.2 2.9 6.6l3.4 3.4M3.2 6.6h6.3a3.9 3.9 0 0 1 0 7.8H7"/>`),
  redo: S(`<path d="M9.7 3.2l3.4 3.4-3.4 3.4M12.8 6.6H6.5a3.9 3.9 0 0 0 0 7.8H9"/>`),
  // compile = produce an artifact: arrow down into a tray
  compile: S(`<path d="M8 2v7.5M4.8 6.2 8 9.5l3.2-3.3M2.5 12.6V14h11v-1.4"/>`),
  new: S(`<path d="M4 1.8h5.2l3 3.2v9.2H4z"/><path d="M9 1.8V5h3.2"/><path d="M8.1 7.4v4M6.1 9.4h4"/>`),
  snap: S(
    `<path d="M5 4.9v2.6a3 3 0 0 0 6 0V4.9"/><rect x="5" y="2.2" width="2.1" height="2.7" fill="currentColor" stroke="none"/><rect x="8.9" y="2.2" width="2.1" height="2.7" fill="currentColor" stroke="none"/>`,
  ),
  eye: S(`<path d="M1.9 8s2-4.1 6.1-4.1S14.1 8 14.1 8 12.1 12.1 8 12.1 1.9 8 1.9 8z"/><circle cx="8" cy="8" r="2.1"/>`),
  eyeOff: S(`<path d="M1.9 8s2-4.1 6.1-4.1S14.1 8 14.1 8 12.1 12.1 8 12.1 1.9 8 1.9 8z"/><circle cx="8" cy="8" r="2.1"/><path d="M3 13.2 13 2.8"/>`),
  collision: S(
    `<rect x="3" y="3" width="10" height="10" stroke-dasharray="2.6 2"/><rect x="5.6" y="5.6" width="4.8" height="4.8" fill="currentColor" stroke="none"/>`,
  ),
  markers: S(`<path d="M8 1.9a4.1 4.1 0 0 1 4.1 4.1c0 3.2-4.1 7.9-4.1 7.9S3.9 9.2 3.9 6A4.1 4.1 0 0 1 8 1.9z"/><circle cx="8" cy="6" r="1.5"/>`),
  grid: S(`<rect x="2" y="2" width="12" height="12"/><path d="M8 2v12M2 8h12"/>`),
  zoomIn: S(`<circle cx="7" cy="7" r="4.6"/><path d="M10.3 10.3 14 14M7 5v4M5 7h4"/>`),
  zoomOut: S(`<circle cx="7" cy="7" r="4.6"/><path d="M10.3 10.3 14 14M5 7h4"/>`),
  fit: S(`<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>`),
  chevron: S(`<path d="M4 6l4 4 4-4"/>`),
  // half-filled rectangle (collision rectangle drawing)
  rect: S(
    `<rect x="2.5" y="2.5" width="11" height="11" fill="currentColor" fill-opacity="0.3" stroke="none"/><rect x="2.5" y="2.5" width="11" height="11"/>`,
  ),
  // brick wall (projectile barrier painting)
  wall: S(
    `<rect x="2" y="3" width="12" height="10"/><path d="M2 6.3h12M2 9.7h12M8 3v3.3M5 6.3v3.4M11 6.3v3.4M8 9.7V13"/>`,
  ),
  // rectangle-draw: dashed rect with corner points (zones, trigger boxes)
  zone: S(
    `<rect x="3" y="3.5" width="10" height="9" stroke-dasharray="2.4 1.8"/><path d="M3 3.5h.01M13 3.5h.01M3 12.5h.01M13 12.5h.01" stroke-width="2.4"/>`,
  ),
  // six-dot grip marking draggable rows
  grip: F(
    `<circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/>`,
  ),
  // sun / moon for the UI theme toggle (shows the current theme, like 顺序 does)
  sun: S(
    `<circle cx="8" cy="8" r="3.1"/><path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>`,
  ),
  moon: S(`<path d="M14 8.5A6 6 0 1 1 7.5 2a4.7 4.7 0 0 0 6.5 6.5z"/>`),
};

// fill every [data-icon] placeholder in the static document
export function hydrateIcons() {
  document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    el.innerHTML = ICONS[el.dataset.icon ?? ""] ?? "";
  });
}
