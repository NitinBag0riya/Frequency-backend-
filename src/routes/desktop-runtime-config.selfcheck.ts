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
import { resolveDesktopRuntimeConfig } from './desktop-runtime-config'

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

  console.log('desktop-runtime-config self-check: OK')
  console.log('  default prod · beta flag → beta URLs · prod flag → prod URLs · routing only, no secrets')
}

main()
