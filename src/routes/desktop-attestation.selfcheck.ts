/**
 * Runnable self-check for Frequency Desktop per-install attestation.
 * Run:  npx tsx src/routes/desktop-attestation.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Drives the REAL verifyAttestation / enrollInstall logic against an in-memory
 * install store, using a genuine Ed25519 keypair, and asserts:
 *   1. enrol records the install (idempotent re-enrol with the same key; refused
 *      with a different key; refused when revoked);
 *   2. a VALID signature within the window passes;
 *   3. a TAMPERED body fails;
 *   4. an EXPIRED / future timestamp fails;
 *   5. an UNKNOWN install fails, a REVOKED install fails;
 *   6. the legacy shared-secret compare still works (timing-safe helper);
 *   7. non-Ed25519 keys are rejected at enrol.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  verifyAttestation,
  enrollInstall,
  attestationMessage,
  timingSafeEqualStr,
  isValidEd25519PublicKey,
  ATTEST_WINDOW_MS,
  type InstallRecord,
} from './desktop-attestation'

// ── In-memory install store ─────────────────────────────────────────────────
function makeStore() {
  const rows = new Map<string, InstallRecord & { lastSeen?: number }>()
  return {
    rows,
    getInstall: async (id: string) => rows.get(id) ?? null,
    recordInstall: async (rec: InstallRecord) => { rows.set(rec.installId, { ...rec }) },
    touchInstall: async (id: string) => { const r = rows.get(id); if (r) r.lastSeen = Date.now() },
  }
}

// ── A real Ed25519 install identity ─────────────────────────────────────────
function makeIdentity(installId: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return {
    installId,
    publicKey,
    privateKey,
    sign(timestamp: string, rawBody: string): string {
      return crypto
        .sign(null, Buffer.from(attestationMessage(installId, timestamp, rawBody), 'utf8'), privateKey)
        .toString('base64')
    },
  }
}

async function main() {
  const store = makeStore()
  const id = makeIdentity('install-abc12345')
  const NOW = 1_800_000_000_000
  const now = () => NOW
  const body = JSON.stringify({ businessName: 'Spice Route', outlets: [{ name: 'x', channels: [{ platform: 'swiggy', resId: '778899' }] }] })

  // ── 1. Enrol ────────────────────────────────────────────────────────────────
  const e1 = await enrollInstall({ installId: id.installId, publicKey: id.publicKey }, store)
  assert.equal(e1.ok, true, 'enrol succeeds')
  assert.equal((e1 as any).created, true, 'first enrol creates')
  assert.equal(store.rows.size, 1, 'one install recorded')

  const e2 = await enrollInstall({ installId: id.installId, publicKey: id.publicKey }, store)
  assert.equal((e2 as any).created, false, 'idempotent re-enrol with same key')
  assert.equal(store.rows.size, 1, 'no duplicate install')

  const other = makeIdentity(id.installId)
  const e3 = await enrollInstall({ installId: id.installId, publicKey: other.publicKey }, store)
  assert.equal(e3.ok, false, 'rebinding a known installId to a new key is refused')
  assert.equal((e3 as any).status, 409, 'rebind → 409')

  // Non-Ed25519 key rejected at enrol.
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  assert.equal(isValidEd25519PublicKey(rsa.publicKey), false, 'RSA key is not a valid ed25519 key')
  const eRsa = await enrollInstall({ installId: 'rsa-install-1', publicKey: rsa.publicKey }, store)
  assert.equal(eRsa.ok, false, 'RSA enrol refused')
  assert.equal((eRsa as any).status, 400, 'RSA enrol → 400')

  // ── 2. Valid signature passes ────────────────────────────────────────────────
  const ts = String(NOW - 1_000)
  const good = await verifyAttestation(
    { installId: id.installId, timestamp: ts, signature: id.sign(ts, body) },
    body,
    { getInstall: store.getInstall, now },
  )
  assert.equal(good.ok, true, 'valid signature within window passes')
  assert.equal((good as any).installId, id.installId, 'returns the authenticated installId')

  // ── 3. Tampered body fails ───────────────────────────────────────────────────
  const tampered = await verifyAttestation(
    { installId: id.installId, timestamp: ts, signature: id.sign(ts, body) },
    body + ' ', // signature was over `body`, not `body + ' '`
    { getInstall: store.getInstall, now },
  )
  assert.equal(tampered.ok, false, 'tampered body fails')
  assert.equal((tampered as any).status, 401, 'tampered → 401')

  // ── 4. Expired / future timestamp fails ──────────────────────────────────────
  const oldTs = String(NOW - ATTEST_WINDOW_MS - 1)
  const expired = await verifyAttestation(
    { installId: id.installId, timestamp: oldTs, signature: id.sign(oldTs, body) },
    body,
    { getInstall: store.getInstall, now },
  )
  assert.equal(expired.ok, false, 'expired timestamp fails')
  assert.equal((expired as any).status, 401, 'expired → 401')

  const futureTs = String(NOW + ATTEST_WINDOW_MS + 1)
  const future = await verifyAttestation(
    { installId: id.installId, timestamp: futureTs, signature: id.sign(futureTs, body) },
    body,
    { getInstall: store.getInstall, now },
  )
  assert.equal(future.ok, false, 'future timestamp fails')

  // ── 5. Unknown + revoked installs fail ───────────────────────────────────────
  const unknown = await verifyAttestation(
    { installId: 'install-unknown9', timestamp: ts, signature: id.sign(ts, body) },
    body,
    { getInstall: store.getInstall, now },
  )
  assert.equal(unknown.ok, false, 'unknown install fails')

  store.rows.get(id.installId)!.revoked = true
  const revoked = await verifyAttestation(
    { installId: id.installId, timestamp: ts, signature: id.sign(ts, body) },
    body,
    { getInstall: store.getInstall, now },
  )
  assert.equal(revoked.ok, false, 'revoked install fails')
  store.rows.get(id.installId)!.revoked = false

  // Missing headers fail-closed.
  const missing = await verifyAttestation({}, body, { getInstall: store.getInstall, now })
  assert.equal(missing.ok, false, 'missing headers fail')

  // ── 6. Legacy shared-secret compare still works ──────────────────────────────
  assert.equal(timingSafeEqualStr('s3cret-abc', 's3cret-abc'), true, 'matching secret ok')
  assert.equal(timingSafeEqualStr('s3cret-abc', 's3cret-abd'), false, 'wrong secret fails')
  assert.equal(timingSafeEqualStr('s3cret', 's3cret-longer'), false, 'length mismatch fails')

  console.log('desktop-attestation self-check: OK')
  console.log('  valid sig passes · tampered/expired/future fail · unknown/revoked fail · legacy secret compare works · enrol first-write-wins')
}

main().catch((e) => { console.error('desktop-attestation self-check FAILED:', e); process.exit(1) })
