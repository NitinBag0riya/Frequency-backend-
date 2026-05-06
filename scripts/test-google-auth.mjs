/**
 * Google Auth Initiation Smoke Test
 * Verifies that the server correctly generates the Google OAuth URL with all required scopes.
 */

const BASE_URL = 'http://localhost:3001'
const TOKEN = 'SMOKE_TEST_TOKEN'

async function test() {
  console.log('🚀 Testing Google OAuth Initiation...')

  const h = {
    'Authorization': `Bearer ${TOKEN}`
  }

  try {
    // 1. Request Google Auth URL
    const res = await fetch(`${BASE_URL}/api/auth/google`, { 
      redirect: 'manual',
      headers: h 
    })
    
    if (res.status !== 302) {
      throw new Error(`Expected 302 redirect, got ${res.status}: ${await res.text()}`)
    }

    const location = res.headers.get('location')
    console.log(`✓ Redirect received: ${location.substring(0, 100)}...`)

    // 2. Verify Scopes in URL
    const url = new URL(location)
    const scopes = url.searchParams.get('scope')
    console.log(`✓ Scopes requested: ${scopes}`)

    const required = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/gmail.modify'
    ]

    for (const s of required) {
      if (!scopes.includes(s)) {
        throw new Error(`Missing required scope: ${s}`)
      }
    }

    console.log('✓ All required Google scopes are present in the OAuth URL.')
    console.log('\n✨ GOOGLE AUTH INITIATION TEST PASSED!')

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message)
    process.exit(1)
  }
}

test()
