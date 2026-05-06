/**
 * Campaign step executor — runs ONE step of a drip campaign for ONE enrollment,
 * then either schedules the next step (via scheduled_jobs) or marks the
 * enrollment completed/exited.
 *
 * Steps are sequential by `position`. After a step finishes, we look up
 * `position + 1` and either:
 *   - immediate kind (send_text/send_template/add_tag) → enqueue next now
 *   - wait_delay → insert scheduled_jobs row, halt
 *   - end (or no next step) → mark completed
 *
 * No worker process imports this file directly — it's called by the worker
 * (campaign-worker.ts) after the schedule-poller dispatches a `campaign_step`
 * job onto the workflow queue (re-using the workflow.execute lane keeps us
 * from spinning a 6th worker for a slow-cadence task).
 */

import { createClient } from '@supabase/supabase-js'
import { enqueueMessageSend } from '../queue'
import { interpolate } from './interpolator'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export interface CampaignAdvanceJob {
  enrollmentId: string
  stepPosition: number
}

/** Run ONE step; advance the enrollment; schedule the next one if needed.
 *  Returns a status string for logging. */
export async function executeCampaignStep(job: CampaignAdvanceJob): Promise<string> {
  const { data: enrollment } = await supabase
    .from('campaign_enrollments')
    .select('*, campaign:campaigns(id, status, tenant_id)')
    .eq('id', job.enrollmentId)
    .maybeSingle()
  if (!enrollment) return `enrollment ${job.enrollmentId} missing`
  if (enrollment.status !== 'active') return `enrollment status=${enrollment.status}, skipping`
  if ((enrollment as any).campaign?.status === 'paused') return 'campaign paused, skipping'

  const tenantId = enrollment.tenant_id
  const vars = (enrollment.variables ?? {}) as Record<string, any>

  const { data: step } = await supabase
    .from('campaign_steps')
    .select('*')
    .eq('campaign_id', enrollment.campaign_id)
    .eq('position', job.stepPosition)
    .maybeSingle()
  if (!step) {
    await markCompleted(enrollment.id, 'no more steps')
    return 'completed (no step found)'
  }

  const cfg = step.config ?? {}

  switch (step.kind) {
    case 'send_template': {
      await enqueueMessageSend({
        tenantId,
        to: enrollment.contact_phone.replace(/^\+/, ''),
        channel: 'whatsapp',
        kind: 'template',
        template: {
          name: cfg.template_name,
          language: cfg.language ?? 'en_US',
          parameters: (cfg.parameters ?? []).map((p: string) => interpolate(p, vars)),
        },
      })
      await advance(enrollment.id, step.position, tenantId)
      return `sent template '${cfg.template_name}'`
    }

    case 'send_text': {
      await enqueueMessageSend({
        tenantId,
        to: enrollment.contact_phone.replace(/^\+/, ''),
        channel: 'whatsapp',
        kind: 'text',
        text: interpolate(cfg.text, vars),
      })
      await advance(enrollment.id, step.position, tenantId)
      return 'sent text'
    }

    case 'add_tag': {
      const tag = interpolate(cfg.tag, vars)
      if (tag && enrollment.contact_id) {
        const { data: c } = await supabase.from('contacts')
          .select('tags').eq('id', enrollment.contact_id).maybeSingle()
        const tags = Array.from(new Set([...(c?.tags ?? []), tag]))
        await supabase.from('contacts').update({ tags }).eq('id', enrollment.contact_id)
      }
      await advance(enrollment.id, step.position, tenantId)
      return `tagged '${tag}'`
    }

    case 'wait_delay': {
      const minutes = Number(cfg.delay_minutes ?? 0)
      const seconds = Number(cfg.delay_seconds ?? 0)
      const delayMs = (minutes * 60 + seconds) * 1000
      const resumeAt = new Date(Date.now() + delayMs).toISOString()
      await supabase.from('scheduled_jobs').insert({
        tenant_id: tenantId,
        kind: 'campaign_step',
        payload: { enrollmentId: enrollment.id, stepPosition: step.position + 1 },
        resume_at: resumeAt,
      })
      // Update enrollment to mark we processed THIS step (waiting for next)
      await supabase.from('campaign_enrollments').update({
        current_step: step.position,
        last_step_at: new Date().toISOString(),
      }).eq('id', enrollment.id)
      return `waiting ${minutes}m ${seconds}s`
    }

    case 'end': {
      await markCompleted(enrollment.id, 'reached end step')
      return 'completed (end)'
    }

    default:
      await advance(enrollment.id, step.position, tenantId)
      return `unknown kind '${step.kind}', skipped`
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function advance(enrollmentId: string, currentPos: number, tenantId: string) {
  const nextPos = currentPos + 1
  const { data: nextStep } = await supabase
    .from('campaign_steps')
    .select('id, kind')
    .eq('campaign_id', (await getEnrollmentCampaignId(enrollmentId)))
    .eq('position', nextPos)
    .maybeSingle()
  await supabase.from('campaign_enrollments').update({
    current_step: currentPos,
    last_step_at: new Date().toISOString(),
  }).eq('id', enrollmentId)

  if (!nextStep) {
    await markCompleted(enrollmentId, 'no further steps')
    return
  }

  // For immediate steps, schedule with resume_at = NOW so the poller picks them
  // up on its next 30s tick. For wait_delay, the step itself defers via
  // scheduled_jobs (handled in its own case branch).
  await supabase.from('scheduled_jobs').insert({
    tenant_id: tenantId,
    kind: 'campaign_step',
    payload: { enrollmentId, stepPosition: nextPos },
    resume_at: new Date().toISOString(),
  })
}

async function getEnrollmentCampaignId(enrollmentId: string): Promise<string | null> {
  const { data } = await supabase.from('campaign_enrollments')
    .select('campaign_id').eq('id', enrollmentId).maybeSingle()
  return data?.campaign_id ?? null
}

async function markCompleted(enrollmentId: string, _reason: string) {
  await supabase.from('campaign_enrollments').update({
    status: 'completed',
    completed_at: new Date().toISOString(),
  }).eq('id', enrollmentId)
}

/**
 * Public helper: enroll a contact (idempotent on (campaign_id, contact_id)).
 * Returns the enrollment row + enqueues step 0.
 */
export async function enrollContact(opts: {
  campaignId: string
  tenantId: string
  contactId?: string | null
  contactPhone: string
  variables?: Record<string, any>
}) {
  // Idempotency: existing active enrollment? Return it.
  if (opts.contactId) {
    const { data: existing } = await supabase
      .from('campaign_enrollments')
      .select('*')
      .eq('campaign_id', opts.campaignId)
      .eq('contact_id', opts.contactId)
      .eq('status', 'active')
      .maybeSingle()
    if (existing) return { enrollment: existing, alreadyEnrolled: true }
  }

  const { data: enrollment, error } = await supabase
    .from('campaign_enrollments')
    .insert({
      campaign_id: opts.campaignId,
      tenant_id: opts.tenantId,
      contact_id: opts.contactId ?? null,
      contact_phone: opts.contactPhone.replace(/^\+/, ''),
      variables: opts.variables ?? {},
      status: 'active',
    })
    .select()
    .single()
  if (error) throw new Error(`enroll: ${error.message}`)

  // Schedule step 0 immediately
  await supabase.from('scheduled_jobs').insert({
    tenant_id: opts.tenantId,
    kind: 'campaign_step',
    payload: { enrollmentId: enrollment.id, stepPosition: 0 },
    resume_at: new Date().toISOString(),
  })

  return { enrollment, alreadyEnrolled: false }
}
