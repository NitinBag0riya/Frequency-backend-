/**
 * Runnable self-check for Frequency Desktop runtime routing config.
 * Run:  npx tsx src/routes/desktop-runtime-config.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Asserts the endpoint's routing rule:
 *   1. unset / unknown flag → prod (never silently beta);
 *   2. flag = 'beta' → beta URLs;
 *   3. flag = 'prod' → prod URLs;
 *   4. no secret ever appears in the returned object.
 */
import assert from 'node:assert/strict'
import { resolveDesktopRuntimeConfig, resolveDesktopManifest } from './desktop-runtime-config'

function main(): void {
  // 1. Default prod on unset / garbage.
  for (const bad of [undefined, null, '', 'staging', 'PROD', 42, {}]) {
    const c = resolveDesktopRuntimeConfig(bad)
    assert.equal(c.env, 'prod', `unknown flag ${JSON.stringify(bad)} → prod`)
    assert.equal(c.apiUrl, 'https://api.getfrequency.app')
    assert.equal(c.provisionUrl, 'https://api.getfrequency.app/api/desktop/provision')
  }

  // 2. beta.
  const beta = resolveDesktopRuntimeConfig('beta')
  assert.equal(beta.env, 'beta')
  assert.equal(beta.baseUrl, 'https://beta.getfrequency.app')
  assert.equal(beta.authUrl, 'https://beta.getfrequency.app')
  assert.equal(beta.apiUrl, 'https://api-beta.getfrequency.app')
  assert.equal(beta.provisionUrl, 'https://api-beta.getfrequency.app/api/desktop/provision')

  // 3. explicit prod.
  const prod = resolveDesktopRuntimeConfig('prod')
  assert.equal(prod.env, 'prod')
  assert.equal(prod.baseUrl, 'https://getfrequency.app')

  // 4. no secret leaks — only the routing keys are present.
  assert.deepEqual(Object.keys(prod).sort(), ['apiUrl', 'authUrl', 'baseUrl', 'env', 'provisionUrl'])
  const blob = JSON.stringify({ prod, beta }).toLowerCase()
  for (const forbidden of ['secret', 'token', 'password', 'key']) {
    assert.ok(!blob.includes(forbidden), `routing payload must not contain "${forbidden}"`)
  }

  // 5. Download manifest — empty/garbage flag → all-null (page falls back), valid → mapped.
  for (const bad of [undefined, null, '', 'x', 42, {}, { mac: 'nope' }]) {
    const man = resolveDesktopManifest(bad)
    assert.equal(man.version, null, `bad manifest flag ${JSON.stringify(bad)} → null version`)
    assert.equal(man.mac, null)
    assert.equal(man.win, null)
  }
  const rel = resolveDesktopManifest({
    version: '0.1.0',
    mac: { url: 'https://updates.getfrequency.app/desktop/Frequency-0.1.0-arm64.dmg', arch: 'Apple silicon' },
    win: { url: 'https://updates.getfrequency.app/desktop/Frequency-Setup-0.1.0.exe' },
    junk: true,
  })
  assert.equal(rel.version, '0.1.0')
  assert.equal(rel.mac?.url, 'https://updates.getfrequency.app/desktop/Frequency-0.1.0-arm64.dmg')
  assert.equal(rel.mac?.arch, 'Apple silicon')
  assert.equal(rel.win?.url, 'https://updates.getfrequency.app/desktop/Frequency-Setup-0.1.0.exe')
  assert.equal((rel.win as any).arch, undefined)
  // A malformed platform entry drops to null without poisoning the rest.
  const partial = resolveDesktopManifest({ version: '9', mac: { arch: 'x' }, win: { url: 'https://h/w.exe' } })
  assert.equal(partial.mac, null)
  assert.equal(partial.win?.url, 'https://h/w.exe')

  console.log('desktop-runtime-config self-check: OK')
  console.log('  default prod · beta flag → beta URLs · prod flag → prod URLs · routing only, no secrets')
  console.log('  manifest: empty flag → all-null · valid flag → mapped · malformed platform → null')
}

main()
