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
