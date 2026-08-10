/**
 * Frequency Desktop runtime routing config.
 *
 * A super-admin sets ONE global flag (feature_flags key `desktop_environment`,
 * value_json.value = 'prod' | 'beta') deciding which backend desktop installs
 * talk to. GET /api/desktop/runtime-config (public, no auth) returns ONLY the
 * non-secret routing URLs below — never the provisioning secret, which stays
 * baked/attested in the install.
 *
 * Defaults to prod on any unknown/unset value so a fresh install or a failed
 * read never silently points a merchant at beta.
 */
export type DesktopEnv = 'prod' | 'beta'

export interface DesktopRuntimeConfig {
  env: DesktopEnv
  baseUrl: string
  authUrl: string
  apiUrl: string
  provisionUrl: string
}

const ENVS: Record<DesktopEnv, Omit<DesktopRuntimeConfig, 'env'>> = {
  prod: {
    baseUrl: 'https://getfrequency.app',
    authUrl: 'https://getfrequency.app',
    apiUrl: 'https://api.getfrequency.app',
    provisionUrl: 'https://api.getfrequency.app/api/desktop/provision',
  },
  beta: {
    baseUrl: 'https://beta.getfrequency.app',
    authUrl: 'https://beta.getfrequency.app',
    apiUrl: 'https://api-beta.getfrequency.app',
    provisionUrl: 'https://api-beta.getfrequency.app/api/desktop/provision',
  },
}

/** Map the stored flag value to a full routing config. Anything but 'beta' → prod. */
export function resolveDesktopRuntimeConfig(flagValue: unknown): DesktopRuntimeConfig {
  const env: DesktopEnv = flagValue === 'beta' ? 'beta' : 'prod'
  return { env, ...ENVS[env] }
}

// ── Desktop download manifest (feeds the dashboard /download page) ────────────
/**
 * What the public /download page needs to render the latest desktop build + per-OS
 * buttons. Fed by a super-admin feature_flags row (key `desktop_release`, value_json
 * shape below) that the owner sets ONCE after uploading the release artifacts.
 *
 * Until that flag is set every field is null → the page shows its built-in fallback /
 * "coming soon" and never a broken link. Purely public routing/metadata — no secrets.
 */
export interface DesktopPlatformDownload {
  url: string
  /** Optional human label for the arch, e.g. "Apple silicon" / "Intel". */
  arch?: string
}
export interface DesktopDownloadManifest {
  version: string | null
  mac: DesktopPlatformDownload | null
  win: DesktopPlatformDownload | null
  notes?: string
  updatedAt?: string
}

function normPlatform(p: unknown): DesktopPlatformDownload | null {
  if (!p || typeof p !== 'object') return null
  const url = (p as any).url
  if (typeof url !== 'string' || !url) return null
  const arch = (p as any).arch
  return { url, ...(typeof arch === 'string' && arch ? { arch } : {}) }
}

/**
 * Build the download manifest from the `desktop_release` flag's value_json. Total +
 * defensive: any missing/garbage field degrades to null so the page still renders.
 * Expected value_json:
 *   { version: "0.1.0",
 *     mac: { url: "https://…/Frequency-0.1.0-arm64.dmg", arch: "Apple silicon" },
 *     win: { url: "https://…/Frequency-Setup-0.1.0.exe" },
 *     notes?: "…", updatedAt?: "2026-08-11" }
 */
export function resolveDesktopManifest(flagValue: unknown): DesktopDownloadManifest {
  const v = (flagValue && typeof flagValue === 'object' ? flagValue : {}) as Record<string, unknown>
  return {
    version: typeof v.version === 'string' && v.version ? v.version : null,
    mac: normPlatform(v.mac),
    win: normPlatform(v.win),
    ...(typeof v.notes === 'string' ? { notes: v.notes } : {}),
    ...(typeof v.updatedAt === 'string' ? { updatedAt: v.updatedAt } : {}),
  }
}
