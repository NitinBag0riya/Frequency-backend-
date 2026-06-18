-- Add the `workflow_schedule` kind to scheduled_jobs.
--
-- This is what powers the trigger_schedule workflow trigger (recurring/cron
-- starts). Deliberately NO new always-on worker: a live workflow with a
-- trigger_schedule node enqueues ONE pending scheduled_jobs row for its next
-- occurrence; the existing 30s schedule-poller fires it and the fire re-enqueues
-- the next occurrence. Cost scales with the number of scheduled workflows
-- (one row + one insert per fire), not with wall-clock — there is no idle burn.
--
-- payload shape: { workflowId: uuid, contactId: text|null, schedule: {...node.config} }

alter table public.scheduled_jobs
  drop constraint if exists scheduled_jobs_kind_check;

alter table public.scheduled_jobs
  add constraint scheduled_jobs_kind_check
  check (kind in (
    'workflow_resume',
    'broadcast_send',
    'campaign_step',
    'template_status_sync',
    'workflow_schedule'
  ));
