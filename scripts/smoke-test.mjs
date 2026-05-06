/**
 * API Smoke Test — Verifies the new Sheet Transformer endpoints.
 * Run with: node scripts/smoke-test.mjs
 */

const BASE_URL = 'http://localhost:3001'
const TOKEN = 'SMOKE_TEST_TOKEN'

async function test() {
  console.log('🚀 Starting API Smoke Test...')

  const h = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  }

  try {
    // 1. Create a dummy table
    console.log('1. Creating dummy table...')
    const tableRes = await fetch(`${BASE_URL}/api/lead-tables`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        name: 'Smoke Test Table',
        description: 'Temporary table for testing',
        source: 'manual',
        columns: [
          { name: 'Full Name', key: 'name', type: 'text' },
          { name: 'Phone Number', key: 'phone', type: 'phone' }
        ]
      })
    })
    
    if (!tableRes.ok) throw new Error(`Create table failed: ${await tableRes.text()}`)
    const table = await tableRes.json()
    console.log(`✓ Table created: ${table.id}`)

    // 2. Save a mapping preset (Transformer)
    console.log('2. Saving mapping preset...')
    const mappingRes = await fetch(`${BASE_URL}/api/lead-tables/${table.id}/mappings`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        name: 'Test Transformer',
        source_type: 'google_sheets',
        mappings: {
          'Full Name': 'name',
          'Phone Number': 'phone'
        }
      })
    })

    if (!mappingRes.ok) throw new Error(`Save mapping failed: ${await mappingRes.text()}`)
    const mapping = await mappingRes.json()
    console.log(`✓ Mapping saved: ${mapping.id}`)

    // 3. Fetch all mappings (Global list)
    console.log('3. Fetching all mappings...')
    const allMappingsRes = await fetch(`${BASE_URL}/api/lead-mappings`, {
      headers: h
    })
    
    if (!allMappingsRes.ok) throw new Error(`Fetch all mappings failed: ${await allMappingsRes.text()}`)
    const allMappings = await allMappingsRes.json()
    const found = allMappings.find(m => m.id === mapping.id)
    if (found) {
      console.log('✓ Found our test mapping in global list')
    } else {
      throw new Error('Test mapping NOT found in global list')
    }

    // 4. Fetch mappings for this table
    console.log('4. Fetching mappings for table...')
    const tableMappingsRes = await fetch(`${BASE_URL}/api/lead-tables/${table.id}/mappings`, {
      headers: h
    })
    const tableMappings = await tableMappingsRes.json()
    if (tableMappings.length > 0) {
      console.log('✓ Found mapping for specific table')
    } else {
      throw new Error('Mapping not found for table')
    }

    // 5. Cleanup
    console.log('5. Cleaning up...')
    await fetch(`${BASE_URL}/api/lead-tables/${table.id}`, {
      method: 'DELETE',
      headers: h
    })
    console.log('✓ Dummy table deleted')

    console.log('\n✨ ALL TESTS PASSED! Mapping workability verified.')

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err.message)
    process.exit(1)
  }
}

test()
