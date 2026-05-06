/**
 * Cross-cutting campaign-trigger hooks. Called whenever a tag, contact field,
 * or external event changes that might enroll a contact in a campaign.
 *
 * Kept as small as possible — each trigger fires `enrollContact` with
 * idempotency, so re-firing is safe.
 */

import { createClient } from '@supabase/supabase-js'
import { enrollContact } from './campaign'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/**
 * Find any active campaign with trigger=tag_added matching the given tag,
 * then enroll the contact. Idempotent — if the contact is already actively
 * enrolled, the helper returns early.
 */
export async function triggerCampaignsByTag(
  tenantId: string,
  contactId: string,
  contactPhone: string,
  tag: string,
): Promise<{ enrolled: number }> {
  if (!tag) return { enrolled: 0 }

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, trigger_config')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .eq('trigger', 'tag_added')

  if (!campaigns || campaigns.length === 0) return { enrolled: 0 }

  let enrolled = 0
  for (const c of campaigns) {
    const targetTag = (c.trigger_config as any)?.tag
    if (!targetTag || targetTag !== tag) continue
    try {
      const { alreadyEnrolled } = await enrollContact({
        campaignId: c.id,
        tenantId,
        contactId,
        contactPhone,
      })
      if (!alreadyEnrolled) enrolled++
    } catch (err) {
      console.warn(`[trigger:tag_added] campaign=${c.id}: ${(err as Error).message}`)
    }
  }
  return { enrolled }
}
