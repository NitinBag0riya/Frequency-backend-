import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const ACME_SLUG = 'acme'
const NEW_WABA_ID = '130541703478952'
const NEW_PHONE_NUMBER_ID = '144958102028751'
const NEW_TOKEN = 'EAAPv0ZAJjZA5oBO7g1wXF1W2BZCq43d6V2zOZAJYZAZBM3w5ZBoZCS1wRzPsz252zXZCRw7yqZCrz0cZAe05uWd8k8w4z6ZB9ZCbZAQ4g25zPZA42sZB8WZA2XZB78P93aZBn0rZB1o3e7g8c4'

async function main() {
  console.log(`Updating tenant '${ACME_SLUG}' in DB...`)
  const { data, error } = await sb.from('tenants')
    .update({
      waba_id: NEW_WABA_ID,
      phone_number_id: NEW_PHONE_NUMBER_ID,
      access_token: NEW_TOKEN,
      display_phone: '+1 555-016-2342'
    })
    .eq('slug', ACME_SLUG)
    .select()

  if (error) {
    console.error('Failed to update tenant:', error)
    process.exit(1)
  }

  console.log('Successfully updated tenant in DB:', data)
}

main().catch(console.error)
