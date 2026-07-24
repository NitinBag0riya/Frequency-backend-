/**
 * Adapter resolver. Given a tenant, return the aggregator adapter that is
 * currently active for them. Today only Frequency Desktop is implemented; adding
 * UrbanPiper / direct is a new `case` here and nothing else changes.
 */
import { SupabaseClient } from '@supabase/supabase-js'
import { AggregatorAdapter, AggregatorSource } from './types'
import { FrequencyDesktopAdapter } from './frequency-desktop-adapter'

export * from './types'
export { FrequencyDesktopAdapter } from './frequency-desktop-adapter'

/** Read the tenant's active aggregator source (defaults to frequency_desktop). */
export async function resolveSource(supabase: SupabaseClient, tenantId: string): Promise<AggregatorSource> {
  const { data } = await supabase.from('tenant_integrations')
    .select('key, status, metadata')
    .eq('tenant_id', tenantId)
    .in('key', ['aggregator_frequency_desktop', 'aggregator_urbanpiper', 'aggregator_zomato_direct', 'aggregator_swiggy_direct'])
    .eq('status', 'active')
  const active = (data ?? []).map(r => (r as any).key as string)
  if (active.includes('aggregator_zomato_direct')) return 'zomato_direct'
  if (active.includes('aggregator_swiggy_direct')) return 'swiggy_direct'
  if (active.includes('aggregator_urbanpiper'))    return 'urbanpiper'
  return 'frequency_desktop'
}

export async function resolveAdapter(supabase: SupabaseClient, tenantId: string): Promise<AggregatorAdapter> {
  const source = await resolveSource(supabase, tenantId)
  switch (source) {
    case 'frequency_desktop':
      return new FrequencyDesktopAdapter(supabase)
    // case 'urbanpiper':    return new UrbanPiperAdapter(supabase)   // future
    // case 'zomato_direct': return new ZomatoDirectAdapter(supabase) // future
    default:
      return new FrequencyDesktopAdapter(supabase)
  }
}
