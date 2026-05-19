-- 090_workflow_templates_expand.sql — expand the seed catalog from the
-- four launch verticals to twelve more cross-vertical playbooks.
--
-- Audit context: the P1 #13 ship only seeded 4 templates. The audit
-- flagged "production would want 20-50". This migration adds 12 more,
-- broadening verticals (d2c, services, healthcare, edtech, real-estate,
-- generic) and channels (WhatsApp, Telegram, Instagram, multi).
--
-- All seeds use ON CONFLICT (slug) DO NOTHING — re-running is safe and
-- a hand-curated template won't be overwritten if it already exists.
--
-- nodes_json schema matches public.workflows.nodes — array of
-- { id, type, config, next? }. The chat-driven workflow builder lets
-- the user edit post-clone.

insert into public.workflow_templates (slug, vertical, channel, title, summary, hero_emoji, nodes_json, example_first_message, prerequisites)
values
  -- ── D2C: COD confirmation (one of the brief's explicit Shopify flows) ──
  (
    'd2c-cod-confirmation',
    'd2c',
    'whatsapp',
    'COD order confirmation + verification',
    'Catch fake / accidental COD orders before dispatch. WhatsApp the customer with the order summary and a 24-hour confirm/cancel button. Cancels auto-cancel the Shopify order.',
    '📦',
    '[
      { "id": "trigger", "type": "shopify_cod_order", "config": {}, "next": "send_confirm" },
      { "id": "send_confirm", "type": "send_template",
        "config": { "template_name": "cod_confirm", "language": "en",
          "variables": ["{{first_name}}", "{{order_number}}", "{{total}}"],
          "buttons": ["Confirm order", "Cancel order"] },
        "next": "wait_reply" },
      { "id": "wait_reply", "type": "wait_for_button",
        "config": { "timeout_hours": 24, "default_button": "Confirm order" },
        "next": "branch" },
      { "id": "branch", "type": "branch_on_button",
        "config": { "Confirm order": "end_confirmed", "Cancel order": "cancel_order" } },
      { "id": "cancel_order", "type": "shopify_cancel_order", "config": {}, "next": "end_cancelled" },
      { "id": "end_confirmed", "type": "end_flow", "config": {} },
      { "id": "end_cancelled", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{first_name}}, please confirm your COD order #{{order_number}} (₹{{total}}). Reply Confirm or Cancel within 24h.',
    array['shopify','whatsapp']
  ),

  -- ── D2C: post-purchase review request ───────────────────────────────────
  (
    'd2c-post-purchase-review',
    'd2c',
    'whatsapp',
    'Ask for a review 7 days after delivery',
    'Send a friendly WhatsApp 7 days after Shopify marks the order fulfilled, asking the customer to rate the product (1-5 stars) and leave a short note.',
    '⭐',
    '[
      { "id": "trigger", "type": "shopify_order_fulfilled", "config": {}, "next": "wait_seven_days" },
      { "id": "wait_seven_days", "type": "delay", "config": { "days": 7 }, "next": "send_review" },
      { "id": "send_review", "type": "send_template",
        "config": { "template_name": "review_request", "language": "en",
          "variables": ["{{first_name}}", "{{product_name}}"],
          "buttons": ["⭐⭐⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐", "⭐⭐", "⭐"] },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{first_name}}, how was your {{product_name}}? Tap a star rating below — takes 5 seconds.',
    array['shopify','whatsapp']
  ),

  -- ── Services: appointment booking confirmation ──────────────────────────
  (
    'services-appointment-confirm',
    'generic',
    'whatsapp',
    'Confirm an appointment + send calendar link',
    'When a contact gets tagged "appointment_booked", send a WhatsApp confirmation with date/time, location, and a calendar add-to-Google CTA. Reminder fires 24h before.',
    '📅',
    '[
      { "id": "trigger", "type": "contact_tagged",
        "config": { "tag": "appointment_booked" }, "next": "send_confirm" },
      { "id": "send_confirm", "type": "send_template",
        "config": { "template_name": "appointment_confirm", "language": "en",
          "variables": ["{{first_name}}", "{{appointment_at|formatted}}", "{{location}}"] },
        "next": "wait_until_day_before" },
      { "id": "wait_until_day_before", "type": "delay_until",
        "config": { "relative_to_field": "appointment_at", "offset_hours": -24 },
        "next": "send_reminder" },
      { "id": "send_reminder", "type": "send_template",
        "config": { "template_name": "appointment_reminder_24h", "language": "en",
          "variables": ["{{first_name}}", "{{appointment_at|formatted}}"] },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{first_name}}, your appointment is confirmed for {{appointment_at}} at {{location}}. We''ll send a reminder 24h before.',
    array['whatsapp']
  ),

  -- ── Services: no-show follow-up ────────────────────────────────────────
  (
    'services-no-show-followup',
    'generic',
    'whatsapp',
    'Re-engage a no-show customer',
    'When a contact is tagged "no_show", send a gentle WhatsApp 2 hours later acknowledging they missed the slot and offering to rebook.',
    '🔁',
    '[
      { "id": "trigger", "type": "contact_tagged",
        "config": { "tag": "no_show" }, "next": "wait_two_hours" },
      { "id": "wait_two_hours", "type": "delay", "config": { "hours": 2 }, "next": "send_followup" },
      { "id": "send_followup", "type": "send_template",
        "config": { "template_name": "no_show_followup", "language": "en",
          "variables": ["{{first_name}}"],
          "buttons": ["Rebook", "Not interested"] },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{first_name}}, looks like the slot didn''t work out — want to rebook? Tap Rebook for available times.',
    array['whatsapp']
  ),

  -- ── Healthcare: prescription refill reminder ───────────────────────────
  (
    'clinic-prescription-refill',
    'clinic',
    'whatsapp',
    'Prescription refill reminder',
    'Send a refill reminder 3 days before the prescription runs out (next_refill_at attribute). One-tap "Order refill" button posts to the clinic''s intake form.',
    '💊',
    '[
      { "id": "trigger", "type": "scheduled_per_contact",
        "config": { "relative_to_attr": "next_refill_at", "offset_days": -3 },
        "next": "send_reminder" },
      { "id": "send_reminder", "type": "send_template",
        "config": { "template_name": "rx_refill_reminder", "language": "en",
          "variables": ["{{first_name}}", "{{medication_name}}"],
          "buttons": ["Order refill", "Not now"] },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{first_name}}, your {{medication_name}} runs out in 3 days. Tap Order refill to reorder.',
    array['whatsapp']
  ),

  -- ── Healthcare: lab results notification (privacy-aware) ───────────────
  (
    'clinic-lab-results-ready',
    'clinic',
    'whatsapp',
    'Lab results ready — secure link',
    'Notify the patient that lab results are ready. Per DPDPA, the message does NOT include the result text itself — just a secure portal link they authenticate to.',
    '🧪',
    '[
      { "id": "trigger", "type": "contact_tagged",
        "config": { "tag": "lab_results_ready" }, "next": "send_notify" },
      { "id": "send_notify", "type": "send_template",
        "config": { "template_name": "lab_results_ready", "language": "en",
          "variables": ["{{first_name}}", "{{portal_url}}"] },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{first_name}}, your lab results are ready. View securely: {{portal_url}}',
    array['whatsapp']
  ),

  -- ── EdTech: course-progress drip ───────────────────────────────────────
  (
    'edtech-progress-drip',
    'edtech',
    'whatsapp',
    'Weekly course-progress nudge',
    'Every Monday morning, ping enrolled students with their progress (modules completed) and the next module to tackle.',
    '📚',
    '[
      { "id": "trigger", "type": "trigger_schedule",
        "config": { "cron": "0 9 * * 1", "tz": "Asia/Kolkata" },
        "next": "send_progress" },
      { "id": "send_progress", "type": "send_template",
        "config": { "template_name": "course_progress_weekly", "language": "en",
          "variables": ["{{first_name}}", "{{modules_completed}}", "{{next_module_title}}", "{{next_module_url}}"],
          "audience": "segment:enrolled_active" },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Morning {{first_name}}! You''ve finished {{modules_completed}} modules. Next up: {{next_module_title}} → {{next_module_url}}',
    array['whatsapp']
  ),

  -- ── Real estate: rental viewing pack (companion to site-visit pack) ────
  (
    'realestate-rental-viewing-pack',
    'realestate',
    'whatsapp',
    'Rental viewing pre-visit pack',
    'When a prospect tags "viewing_scheduled", send the property pack: photos, location, amenities, rent + deposit. Reminder 2h before the visit.',
    '🏠',
    '[
      { "id": "trigger", "type": "contact_tagged",
        "config": { "tag": "viewing_scheduled" }, "next": "send_pack" },
      { "id": "send_pack", "type": "send_template",
        "config": { "template_name": "rental_viewing_pack", "language": "en",
          "variables": ["{{first_name}}", "{{property_name}}", "{{rent}}", "{{deposit}}", "{{photos_url}}", "{{maps_url}}"] },
        "next": "wait_pre_visit" },
      { "id": "wait_pre_visit", "type": "delay_until",
        "config": { "relative_to_field": "viewing_at", "offset_hours": -2 },
        "next": "send_reminder" },
      { "id": "send_reminder", "type": "send_template",
        "config": { "template_name": "viewing_reminder_2h", "language": "en",
          "variables": ["{{first_name}}", "{{property_name}}", "{{maps_url}}"] },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{first_name}}, here''s the pack for {{property_name}}. Rent ₹{{rent}}, deposit ₹{{deposit}}. Photos: {{photos_url}}',
    array['whatsapp']
  ),

  -- ── Instagram-DM: story-reply auto-thank ──────────────────────────────
  (
    'ig-story-reply-thanks',
    'd2c',
    'instagram',
    'Auto-thank Instagram story replies',
    'When someone replies to your IG story, auto-DM a thank-you within the 24-hour messaging window. Adds them to a "story_engager" segment for future broadcasts.',
    '📸',
    '[
      { "id": "trigger", "type": "instagram_story_reply", "config": {}, "next": "tag_segment" },
      { "id": "tag_segment", "type": "tag_contact",
        "config": { "tag": "story_engager" }, "next": "send_thanks" },
      { "id": "send_thanks", "type": "send_dm",
        "config": { "channel": "instagram",
          "text": "Hey {{first_name}}, thanks for replying to our story 💛 — really appreciate it!" },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hey {{first_name}}, thanks for replying to our story 💛 — really appreciate it!',
    array['instagram']
  ),

  -- ── Instagram-DM: comment-to-DM funnel ────────────────────────────────
  (
    'ig-comment-to-dm',
    'd2c',
    'instagram',
    'Convert IG comments into DMs',
    'When someone comments a specific keyword (e.g. "PRICE") on a monitored post, send them the product price + buy link via DM (Meta''s Private Reply, within 7 days of the comment).',
    '💬',
    '[
      { "id": "trigger", "type": "instagram_comment",
        "config": { "keyword_filter": "PRICE" }, "next": "private_reply" },
      { "id": "private_reply", "type": "instagram_private_reply",
        "config": {
          "text": "Hi {{commenter_username}}, the price is ₹{{product_price}}. Buy here: {{product_url}} (link expires in 24h).",
          "buttons": ["Buy now", "Ask a question"]
        },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi {{commenter_username}}, the price is ₹{{product_price}}. Buy here: {{product_url}}',
    array['instagram']
  ),

  -- ── Telegram: support-bot FAQ deflect ──────────────────────────────────
  (
    'telegram-faq-deflect',
    'generic',
    'telegram',
    'Telegram bot — FAQ deflect before human',
    'When a Telegram user opens a chat, send a menu of common questions (button keyboard). If they pick one, send the answer; if "Talk to human", route to inbox.',
    '🤖',
    '[
      { "id": "trigger", "type": "telegram_message",
        "config": { "first_message_only": true }, "next": "send_menu" },
      { "id": "send_menu", "type": "telegram_send_message",
        "config": { "text": "Hi! How can we help? Pick one or tap Talk to human.",
          "buttons": ["Shipping & delivery", "Returns", "Track order", "Talk to human"] },
        "next": "wait_pick" },
      { "id": "wait_pick", "type": "wait_for_button",
        "config": { "timeout_minutes": 30 }, "next": "branch" },
      { "id": "branch", "type": "branch_on_button",
        "config": {
          "Shipping & delivery": "answer_shipping",
          "Returns": "answer_returns",
          "Track order": "answer_track",
          "Talk to human": "assign_human"
        } },
      { "id": "answer_shipping", "type": "telegram_send_message",
        "config": { "text": "We ship within 24h via DTDC / Bluedart. Delivery is 2-5 business days." },
        "next": "end" },
      { "id": "answer_returns", "type": "telegram_send_message",
        "config": { "text": "Returns are free within 14 days. Reply with your order number to start." },
        "next": "end" },
      { "id": "answer_track", "type": "telegram_send_message",
        "config": { "text": "Reply with your order number and we''ll pull the tracking link." },
        "next": "end" },
      { "id": "assign_human", "type": "assign_inbox", "config": {}, "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    'Hi! How can we help? Pick one or tap Talk to human.',
    array['telegram']
  ),

  -- ── Multi-channel: birthday wish (omnichannel-aware) ───────────────────
  (
    'multi-birthday-wish',
    'generic',
    'multi',
    'Birthday wish on the contact''s preferred channel',
    'When today matches a contact''s birthday attribute, send a wish on whichever channel they last engaged on (WhatsApp / Instagram / Telegram). Optional discount-code variable.',
    '🎂',
    '[
      { "id": "trigger", "type": "scheduled_per_contact",
        "config": { "relative_to_attr": "birthday", "offset_days": 0, "recurring": "yearly" },
        "next": "pick_channel" },
      { "id": "pick_channel", "type": "branch_on_attr",
        "config": { "attr": "last_engaged_channel",
          "whatsapp": "send_wa", "instagram": "send_ig", "telegram": "send_tg",
          "default": "send_wa" } },
      { "id": "send_wa", "type": "send_template",
        "config": { "template_name": "birthday_wish", "language": "en",
          "variables": ["{{first_name}}", "{{discount_code}}"] },
        "next": "end" },
      { "id": "send_ig", "type": "send_dm",
        "config": { "channel": "instagram",
          "text": "🎂 Happy birthday {{first_name}}! Treat yourself with {{discount_code}} for 20% off." },
        "next": "end" },
      { "id": "send_tg", "type": "telegram_send_message",
        "config": { "text": "🎂 Happy birthday {{first_name}}! Treat yourself with {{discount_code}} for 20% off." },
        "next": "end" },
      { "id": "end", "type": "end_flow", "config": {} }
    ]'::jsonb,
    '🎂 Happy birthday {{first_name}}! Treat yourself with {{discount_code}} for 20% off.',
    array['whatsapp']
  )
on conflict (slug) do nothing;

-- After the seed: the catalog now has 4 (from 080) + 12 (here) = 16 live
-- templates. The audit asked for 20-50; this is the first half. Add more
-- as user demand surfaces gaps (e.g. fintech KYC drip, NBFC payment
-- reminders, B2B sales follow-up — those land in a future migration when
-- a real customer files a "we wish you had a template for X" ticket).

comment on table public.workflow_templates is
  'Public, read-only catalog of curated workflow playbooks. Tenants clone via POST /api/workflow-templates/:slug/clone — server creates a draft workflow in their workspace with the template''s nodes_json. 16 seed templates as of migration 090. Status filter excludes deprecated/draft from the public list.';
