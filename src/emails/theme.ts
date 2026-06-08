/**
 * Email design tokens — single source of truth.
 *
 * Mirrors the app's v2 design system (tailwind.config.ts + src/index.css in
 * the frontend) so every Frequency-branded email matches the product:
 *   - Figtree (variable) for all copy; JetBrains Mono for IDs / codes / money
 *   - brand green ramp (primary = brand[600] #0F6E56)
 *   - 0.6rem base radius, cream-neutral page background, hairline card borders
 *
 * Email clients strip <style> and most ignore web fonts (Gmail, Outlook for
 * Windows, Yahoo), so EVERYTHING here is expressed as inline-style-ready
 * primitives and every text node must carry `fontFamily: theme.font.sans`.
 * Figtree (loaded via <Font> in Layout) is a progressive enhancement that
 * only Apple Mail / iOS reliably honor.
 */

export const brand = {
  50:  '#E1F5EE',
  100: '#9FE1CB',
  200: '#5DCAA5',
  400: '#1D9E75',
  600: '#0F6E56', // primary
  800: '#085041',
  900: '#04342C',
} as const

export const color = {
  brand:        brand[600],
  brandDark:    brand[800],
  brandTint:    brand[50],

  /** Page chrome behind the card. */
  pageBg:       '#f7f8f7',
  /** Card surface. */
  surface:      '#ffffff',
  /** Hairline borders / dividers. */
  border:       '#e6e8e6',
  borderFaint:  '#f0f1f0',

  /** Near-black headings. */
  heading:      '#16181d',
  /** Body copy. */
  text:         '#374151',
  /** Secondary / muted copy. */
  muted:        '#4b5563',
  /** Faint metadata + footer. */
  faint:        '#9ca3af',

  /** On-brand text (inside green buttons / banners). */
  onBrand:      '#ffffff',

  /** Status accents (kept rare — only invoices/alerts use them). */
  positive:     brand[600],
  danger:       '#dc2626',
  dangerTint:   '#fef2f2',
  codeBg:       '#f5f6f5',
} as const

/** Font stacks. Figtree first, then a robust system fallback that is what
 *  most recipients actually render. */
export const font = {
  sans: "'Figtree','Figtree Variable',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  mono: "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
} as const

/** The variable Figtree woff2 (covers all weights). Used by the <Font>
 *  component in Layout. */
export const figtreeWebFont = {
  url:    'https://fonts.gstatic.com/s/figtree/v9/_Xms-HUzqDCFdgfMq4a3CoZt.woff2',
  format: 'woff2' as const,
}

/** Border radii (app base --radius: 0.6rem ≈ 10px). */
export const radius = {
  card:   '14px',
  button: '10px',
  chip:   '8px',
} as const

/** 4px spacing scale → use these instead of magic numbers. */
export const space = {
  xs:  '6px',
  sm:  '12px',
  md:  '16px',
  lg:  '24px',
  xl:  '32px',
  xxl: '40px',
} as const

/** Type scale (px) mirroring the app's UI tokens (h1..caption, body). */
export const type = {
  h1:      { fontSize: '24px', lineHeight: '1.2',  fontWeight: 700, letterSpacing: '-0.014em' },
  h2:      { fontSize: '20px', lineHeight: '1.25', fontWeight: 700, letterSpacing: '-0.012em' },
  h3:      { fontSize: '17px', lineHeight: '1.3',  fontWeight: 700, letterSpacing: '-0.008em' },
  bodyLg:  { fontSize: '16px', lineHeight: '1.55', fontWeight: 400 },
  body:    { fontSize: '14.5px', lineHeight: '1.55', fontWeight: 400 },
  bodySm:  { fontSize: '13px', lineHeight: '1.5',  fontWeight: 400 },
  caption: { fontSize: '12px', lineHeight: '1.5',  fontWeight: 400 },
  eyebrow: { fontSize: '11px', lineHeight: '1.4',  fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const },
} as const

/** Max content width of the card. */
export const layout = {
  cardWidth:    560,
  /** Invoices need a wider canvas so the legal table isn't clipped. */
  invoiceWidth: 680,
} as const

/** Default app URL used when none is provided. */
export const APP_URL = process.env.FRONTEND_URL ?? 'https://app.getfrequency.app'

/**
 * Frequency logo for email headers. MUST be an absolute https raster (PNG/JPG)
 * — email clients (Gmail/Outlook) don't render SVG. Defaults to the apex
 * app-icon PNG; override with EMAIL_LOGO_URL if a wordmark PNG is hosted later.
 */
export const LOGO_URL = process.env.EMAIL_LOGO_URL ?? 'https://getfrequency.app/apple-touch-icon.png'
export const LOGO_SIZE = 30
