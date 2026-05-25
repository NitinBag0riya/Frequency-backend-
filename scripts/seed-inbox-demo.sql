-- ──────────────────────────────────────────────────────────────────────────
-- Seed demo inbox data on the `acme` tenant (id: 56481854-…fdb0).
--
-- Idempotent: re-running deletes any previously-seeded demo rows
-- (matched by platform_message_id LIKE 'demo_%' + contacts tagged 'demo')
-- before inserting fresh ones.
--
-- 4 contacts, 18 messages — covers every WhatsApp message shape the
-- inbox needs to render: templates (with body parameters + buttons),
-- inbound button_reply taps, plain text both directions, image with
-- caption, document attachment, and a no-reply "template sent" state.
--
-- Run via:
--   psql "$SUPABASE_DB_URL" -f scripts/seed-inbox-demo.sql
-- or via the Supabase Management API SQL editor.
-- ──────────────────────────────────────────────────────────────────────────

-- Idempotent cleanup of any prior demo data
DELETE FROM messages WHERE platform_message_id LIKE 'demo\_%' ESCAPE '\';
DELETE FROM contacts WHERE tenant_id='56481854-951e-40b2-9a3a-aa1e7254fdb0' AND 'demo' = ANY(tags);

DO $$
DECLARE
  acme uuid := '56481854-951e-40b2-9a3a-aa1e7254fdb0';
BEGIN
  INSERT INTO contacts (id, tenant_id, name, phone, tags, status, attributes, last_contacted_at) VALUES
    (gen_random_uuid(), acme, 'Priya Sharma',  '+919812345670', ARRAY['demo','lead','3bhk'],         'active', '{"source":"BHK template","budget":"85L"}'::jsonb, now() - interval '12 minutes'),
    (gen_random_uuid(), acme, 'Rohan Verma',   '+919823456781', ARRAY['demo','lead','2bhk','image'], 'active', '{"source":"Welcome template"}'::jsonb,             now() - interval '47 minutes'),
    (gen_random_uuid(), acme, 'Anjali Mehta',  '+919834567892', ARRAY['demo','commercial'],          'active', '{"source":"Commercial intro","interest":"Sector 18"}'::jsonb, now() - interval '2 hours'),
    (gen_random_uuid(), acme, 'Vikram Reddy',  '+919845678903', ARRAY['demo','lead','no-reply'],     'active', '{"source":"BHK template","stage":"sent"}'::jsonb,  now() - interval '6 hours');

  INSERT INTO messages (tenant_id, direction, contact_phone, channel, platform_message_id, content, status, created_at) VALUES
    -- Priya: full BHK conversion conversation
    (acme, 'outbound', '+919812345670', 'whatsapp', 'demo_priya_1',
     '{"type":"template","template":{"name":"lead_welcome_bhk","language":{"code":"en_US"},"components":[{"type":"body","parameters":[{"type":"text","text":"Priya"}]},{"type":"button","sub_type":"quick_reply","index":0,"parameters":[{"type":"payload","payload":"1bhk"}]},{"type":"button","sub_type":"quick_reply","index":1,"parameters":[{"type":"payload","payload":"2bhk"}]},{"type":"button","sub_type":"quick_reply","index":2,"parameters":[{"type":"payload","payload":"3bhk"}]}]}}'::jsonb,
     'read', now() - interval '1 hour'),
    (acme, 'inbound', '+919812345670', 'whatsapp', 'demo_priya_2',
     '{"type":"interactive","interactive":{"type":"button_reply","button_reply":{"id":"3bhk","title":"3 BHK"}}}'::jsonb,
     'sent', now() - interval '58 minutes'),
    (acme, 'outbound', '+919812345670', 'whatsapp', 'demo_priya_3',
     '{"type":"text","text":{"body":"Thanks for choosing 3 BHK, Priya! Our team will reach out shortly with options that match your interest."}}'::jsonb,
     'read', now() - interval '57 minutes'),
    (acme, 'inbound', '+919812345670', 'whatsapp', 'demo_priya_4',
     '{"type":"text","text":{"body":"What''s your best price?"}}'::jsonb,
     'sent', now() - interval '30 minutes'),
    (acme, 'outbound', '+919812345670', 'whatsapp', 'demo_priya_5',
     '{"type":"text","text":{"body":"Our 3 BHK units start at ₹85L. Want to schedule a site visit this weekend?"}}'::jsonb,
     'read', now() - interval '28 minutes'),
    (acme, 'inbound', '+919812345670', 'whatsapp', 'demo_priya_6',
     '{"type":"interactive","interactive":{"type":"button_reply","button_reply":{"id":"yes_visit","title":"Yes, Saturday"}}}'::jsonb,
     'sent', now() - interval '12 minutes'),

    -- Rohan: image inquiry + brochure send
    (acme, 'outbound', '+919823456781', 'whatsapp', 'demo_rohan_1',
     '{"type":"template","template":{"name":"welcome_lead","language":{"code":"en_US"},"components":[{"type":"body","parameters":[{"type":"text","text":"Rohan"}]}]}}'::jsonb,
     'read', now() - interval '4 hours'),
    (acme, 'inbound', '+919823456781', 'whatsapp', 'demo_rohan_2',
     '{"type":"image","image":{"id":"demo-img-1","caption":"Is this 2 BHK still available?","mime_type":"image/jpeg"}}'::jsonb,
     'sent', now() - interval '3 hours 30 minutes'),
    (acme, 'outbound', '+919823456781', 'whatsapp', 'demo_rohan_3',
     '{"type":"text","text":{"body":"Yes! That 2 BHK in Tower B is still available. Asking ₹62L. Want me to send the brochure?"}}'::jsonb,
     'read', now() - interval '3 hours 28 minutes'),
    (acme, 'inbound', '+919823456781', 'whatsapp', 'demo_rohan_4',
     '{"type":"interactive","interactive":{"type":"button_reply","button_reply":{"id":"send_brochure","title":"Send brochure"}}}'::jsonb,
     'sent', now() - interval '50 minutes'),
    (acme, 'outbound', '+919823456781', 'whatsapp', 'demo_rohan_5',
     '{"type":"document","document":{"id":"demo-doc-1","filename":"Acme_2BHK_TowerB_Brochure.pdf","mime_type":"application/pdf"}}'::jsonb,
     'delivered', now() - interval '47 minutes'),

    -- Anjali: commercial site visit booking
    (acme, 'outbound', '+919834567892', 'whatsapp', 'demo_anjali_1',
     '{"type":"template","template":{"name":"commercial_intro","language":{"code":"en_US"},"components":[{"type":"body","parameters":[{"type":"text","text":"Anjali"}]}]}}'::jsonb,
     'read', now() - interval '5 hours'),
    (acme, 'inbound', '+919834567892', 'whatsapp', 'demo_anjali_2',
     '{"type":"text","text":{"body":"Looking at the Sector 18 commercial listing"}}'::jsonb,
     'sent', now() - interval '4 hours 50 minutes'),
    (acme, 'outbound', '+919834567892', 'whatsapp', 'demo_anjali_3',
     '{"type":"text","text":{"body":"Great choice! Sector 18 has 1200 sqft available. Sharing the floor plan now."}}'::jsonb,
     'read', now() - interval '4 hours 48 minutes'),
    (acme, 'outbound', '+919834567892', 'whatsapp', 'demo_anjali_4',
     '{"type":"image","image":{"id":"demo-img-2","caption":"Sector 18 — 1200 sqft floor plan","mime_type":"image/png"}}'::jsonb,
     'read', now() - interval '4 hours 47 minutes'),
    (acme, 'inbound', '+919834567892', 'whatsapp', 'demo_anjali_5',
     '{"type":"text","text":{"body":"Can we visit tomorrow at 4pm?"}}'::jsonb,
     'sent', now() - interval '2 hours 10 minutes'),
    (acme, 'outbound', '+919834567892', 'whatsapp', 'demo_anjali_6',
     '{"type":"text","text":{"body":"Booked! Tomorrow 4pm at Sector 18 site. Our team will meet you there."}}'::jsonb,
     'read', now() - interval '2 hours'),

    -- Vikram: template sent, no reply yet
    (acme, 'outbound', '+919845678903', 'whatsapp', 'demo_vikram_1',
     '{"type":"template","template":{"name":"lead_welcome_bhk","language":{"code":"en_US"},"components":[{"type":"body","parameters":[{"type":"text","text":"Vikram"}]},{"type":"button","sub_type":"quick_reply","index":0,"parameters":[{"type":"payload","payload":"1bhk"}]},{"type":"button","sub_type":"quick_reply","index":1,"parameters":[{"type":"payload","payload":"2bhk"}]},{"type":"button","sub_type":"quick_reply","index":2,"parameters":[{"type":"payload","payload":"3bhk"}]}]}}'::jsonb,
     'delivered', now() - interval '6 hours');
END $$;
