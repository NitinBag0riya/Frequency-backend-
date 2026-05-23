-- ────────────────────────────────────────────────────────────────────────
-- Migration 111 — Industry-standard form templates (Block E expansion)
-- ────────────────────────────────────────────────────────────────────────
-- Adds 12 curated templates covering the most common Indian SMB
-- verticals so a brand-new tenant can fork-to-ship in under a minute.
-- Each template uses sensible field-id slugs (name, phone, email, ...)
-- so the auto-mapping to the destination Table just works.
-- ────────────────────────────────────────────────────────────────────────

insert into public.form_templates (slug, title, description, category, schema_json, is_curated, screenshot_url) values
  (
    'restaurant-dine-in-feedback',
    'Restaurant dine-in feedback',
    'Star rating + comment + revisit intent. Auto-WhatsApp discount on 4★+.',
    'survey',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"sec","kind":"section","heading":"How was your meal?","body":"Quick rating helps us serve you better."},
       {"id":"f","kind":"form","submit_label":"Share feedback","success_message":"Thanks! Look out for our WhatsApp.","fields":[
         {"id":"name","kind":"short_text","label":"Your name","required":true},
         {"id":"phone","kind":"phone","label":"WhatsApp number","required":true},
         {"id":"rating","kind":"rating","label":"Rate your experience","rating_max":5,"required":true},
         {"id":"dish","kind":"short_text","label":"Favourite dish today"},
         {"id":"comments","kind":"long_text","label":"Anything we could improve?"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'salon-appointment',
    'Salon / spa appointment',
    'Service + stylist + date/time. Auto-WhatsApp confirmation with prep tips.',
    'booking',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"f","kind":"form","submit_label":"Book my slot","success_message":"Appointment requested. You will hear from us within an hour.","fields":[
         {"id":"name","kind":"short_text","label":"Your name","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"service","kind":"select","label":"Service","required":true,"options":["Haircut","Hair colour","Manicure","Pedicure","Facial","Spa","Bridal package"]},
         {"id":"stylist","kind":"select","label":"Stylist preference","options":["No preference","Senior stylist","Junior stylist","Specific stylist (note below)"]},
         {"id":"date","kind":"date","label":"Preferred date","required":true},
         {"id":"time","kind":"select","label":"Preferred time","options":["Morning (9-12)","Afternoon (12-4)","Evening (4-8)"]},
         {"id":"notes","kind":"long_text","label":"Notes for the stylist"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'doctor-consultation',
    'Doctor appointment / teleconsult',
    'Patient intake with concern + insurance. HIPAA-style minimum disclosure.',
    'booking',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"f","kind":"form","submit_label":"Request appointment","success_message":"Our coordinator will WhatsApp you to confirm.","fields":[
         {"id":"name","kind":"short_text","label":"Patient name","required":true},
         {"id":"age","kind":"number","label":"Age","required":true,"min":0,"max":120,"step":1},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"concern","kind":"long_text","label":"Reason for visit (brief)","required":true},
         {"id":"mode","kind":"radio","label":"Consultation type","options":["In-clinic","Video teleconsult"],"required":true},
         {"id":"date","kind":"date","label":"Preferred date","required":true},
         {"id":"insurance","kind":"select","label":"Insurance provider","options":["Self-pay","Star Health","HDFC ERGO","Niva Bupa","ICICI Lombard","Other"]}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'school-admission-inquiry',
    'School admission inquiry',
    'Parent + child + grade. Pre-screens for slot availability.',
    'lead_capture',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"f","kind":"form","submit_label":"Request callback","success_message":"Our admissions team will call within 24 hours.","fields":[
         {"id":"parent_name","kind":"short_text","label":"Parent / guardian name","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"email","kind":"email","label":"Email"},
         {"id":"child_name","kind":"short_text","label":"Child name","required":true},
         {"id":"grade","kind":"select","label":"Grade applying for","required":true,"options":["Pre-KG / Nursery","Kindergarten","Class 1","Class 2","Class 3","Class 4","Class 5","Class 6","Class 7","Class 8","Class 9","Class 10","Class 11","Class 12"]},
         {"id":"prev_school","kind":"short_text","label":"Previous school (if any)"},
         {"id":"city","kind":"short_text","label":"City / locality","required":true}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'gym-membership-enrollment',
    'Gym / fitness membership',
    'Plan + payment-mode + emergency contact. Razorpay-ready.',
    'payment',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"hero","kind":"hero","headline":"Join the strongest you","subheadline":"Pick a plan, start tomorrow."},
       {"id":"f","kind":"form","submit_label":"Enroll","success_message":"Welcome! Onboarding details on WhatsApp.","fields":[
         {"id":"name","kind":"short_text","label":"Full name","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"email","kind":"email","label":"Email","required":true},
         {"id":"plan","kind":"radio","label":"Plan","required":true,"options":["1 month - ₹1,500","3 months - ₹4,000","6 months - ₹7,500","12 months - ₹13,000"]},
         {"id":"goals","kind":"long_text","label":"Your fitness goals"},
         {"id":"emergency","kind":"phone","label":"Emergency contact"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'wedding-inquiry',
    'Wedding planning inquiry',
    'Date + guest count + venue + budget. High-LTV lead capture.',
    'lead_capture',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"hero","kind":"hero","headline":"Plan your dream wedding","subheadline":"Tell us your vision; we will craft a quote."},
       {"id":"f","kind":"form","submit_label":"Get a quote","success_message":"Our planner will reach out within 24 hours.","fields":[
         {"id":"name","kind":"short_text","label":"Your name","required":true},
         {"id":"phone","kind":"phone","label":"WhatsApp number","required":true},
         {"id":"email","kind":"email","label":"Email"},
         {"id":"wedding_date","kind":"date","label":"Tentative wedding date","required":true},
         {"id":"guests","kind":"number","label":"Expected guest count","min":10,"max":5000,"step":50,"required":true},
         {"id":"venue_type","kind":"select","label":"Venue preference","options":["Banquet hall","Hotel","Outdoor / beach","Heritage / palace","Destination (overseas)"]},
         {"id":"budget","kind":"select","label":"Budget range","required":true,"options":["Below ₹5L","₹5-15L","₹15-50L","₹50L-1Cr","Above ₹1Cr"]},
         {"id":"services","kind":"long_text","label":"Services needed (catering, decor, photography, etc.)"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'loan-application-inquiry',
    'Loan application inquiry',
    'NBFC-ready: PAN + employment + amount + tenure.',
    'lead_capture',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"sec","kind":"section","heading":"Personal loan in 24 hours","body":"Quick eligibility check. Final approval subject to verification."},
       {"id":"f","kind":"form","submit_label":"Check eligibility","success_message":"Our agent will call you within 2 hours.","fields":[
         {"id":"name","kind":"short_text","label":"Full name (as on PAN)","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"email","kind":"email","label":"Email","required":true},
         {"id":"employment","kind":"radio","label":"Employment type","required":true,"options":["Salaried","Self-employed","Business owner","Freelancer"]},
         {"id":"income","kind":"select","label":"Monthly income","required":true,"options":["Below ₹25K","₹25-50K","₹50K-1L","₹1-3L","Above ₹3L"]},
         {"id":"amount","kind":"select","label":"Loan amount","required":true,"options":["Below ₹1L","₹1-5L","₹5-10L","₹10-25L","Above ₹25L"]},
         {"id":"tenure","kind":"select","label":"Repayment tenure","options":["12 months","24 months","36 months","48 months","60 months"]},
         {"id":"city","kind":"short_text","label":"City","required":true},
         {"id":"consent","kind":"checkbox","label":"I agree to be contacted by the lender and consent to a credit check","required":true}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'insurance-quote-request',
    'Insurance quote request',
    'Health / car / life — auto-routes to specialist agent.',
    'lead_capture',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"f","kind":"form","submit_label":"Get my quote","success_message":"A licensed agent will WhatsApp you within 30 mins.","fields":[
         {"id":"name","kind":"short_text","label":"Full name","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"email","kind":"email","label":"Email","required":true},
         {"id":"type","kind":"radio","label":"Insurance type","required":true,"options":["Health","Car / two-wheeler","Term life","Travel","Home"]},
         {"id":"age","kind":"number","label":"Age of insured","min":0,"max":99,"step":1},
         {"id":"sum_insured","kind":"select","label":"Sum insured","options":["₹5L","₹10L","₹25L","₹50L","₹1Cr+"]},
         {"id":"existing","kind":"radio","label":"Existing policy?","options":["No, first-time","Yes, renewing","Yes, switching from another insurer"]}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'b2b-demo-request',
    'B2B SaaS demo request',
    'Company size + use case + decision timeline. Sales-team-ready.',
    'lead_capture',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"hero","kind":"hero","headline":"See it in action","subheadline":"15-minute live walkthrough of how teams like yours use us."},
       {"id":"f","kind":"form","submit_label":"Book my demo","success_message":"Calendar invite landing in your inbox.","fields":[
         {"id":"name","kind":"short_text","label":"Your name","required":true},
         {"id":"work_email","kind":"email","label":"Work email","required":true},
         {"id":"company","kind":"short_text","label":"Company","required":true},
         {"id":"role","kind":"select","label":"Your role","required":true,"options":["Founder / CEO","CTO / VP Engineering","Head of Sales","Head of Marketing","Operations","Other"]},
         {"id":"company_size","kind":"select","label":"Team size","required":true,"options":["1-10","11-50","51-200","201-1000","1000+"]},
         {"id":"use_case","kind":"long_text","label":"What are you trying to solve?"},
         {"id":"timeline","kind":"select","label":"Decision timeline","options":["This week","This month","This quarter","Just exploring"]}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'job-application',
    'Job application',
    'Resume upload + experience + notice period. HR-ready intake.',
    'other',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"sec","kind":"section","heading":"Apply for this role","body":"We review every application personally. Expect a reply within 5 business days."},
       {"id":"f","kind":"form","submit_label":"Submit application","success_message":"Got it! We will get back to you within 5 business days.","fields":[
         {"id":"name","kind":"short_text","label":"Full name","required":true},
         {"id":"email","kind":"email","label":"Email","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"role","kind":"short_text","label":"Position applying for","required":true},
         {"id":"experience","kind":"select","label":"Years of experience","required":true,"options":["Fresher","1-3 years","3-5 years","5-10 years","10+ years"]},
         {"id":"current_ctc","kind":"select","label":"Current CTC","options":["Fresher","< ₹3L","₹3-6L","₹6-12L","₹12-25L","> ₹25L"]},
         {"id":"expected_ctc","kind":"select","label":"Expected CTC","options":["< ₹3L","₹3-6L","₹6-12L","₹12-25L","> ₹25L","Negotiable"]},
         {"id":"notice_period","kind":"select","label":"Notice period","options":["Immediate","15 days","30 days","60 days","90 days"]},
         {"id":"resume","kind":"file","label":"Resume / CV","accept":["application/pdf",".pdf",".doc",".docx"],"required":true},
         {"id":"cover","kind":"long_text","label":"Why this role?"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'product-preorder-d2c',
    'D2C product pre-order',
    'Variant + qty + shipping. Razorpay-ready order intake.',
    'payment',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"hero","kind":"hero","headline":"Be first in line","subheadline":"Pre-order now, ship in 2 weeks."},
       {"id":"f","kind":"form","submit_label":"Place pre-order","success_message":"Pre-order confirmed. Tracking via WhatsApp.","fields":[
         {"id":"name","kind":"short_text","label":"Full name","required":true},
         {"id":"phone","kind":"phone","label":"Phone","required":true},
         {"id":"email","kind":"email","label":"Email","required":true},
         {"id":"variant","kind":"radio","label":"Pick a variant","required":true,"options":["Standard","Premium","Limited edition"]},
         {"id":"qty","kind":"number","label":"Quantity","min":1,"max":10,"step":1,"required":true},
         {"id":"address","kind":"long_text","label":"Shipping address","required":true},
         {"id":"pincode","kind":"short_text","label":"PIN code","required":true}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  ),
  (
    'coaching-class-enrollment',
    'Coaching / tuition enrollment',
    'Student + class + batch preference. Common for IIT/NEET/UPSC prep.',
    'lead_capture',
    '{"version":1,"widgets":[
       {"id":"h","kind":"header","show_contact_strip":true},
       {"id":"f","kind":"form","submit_label":"Enroll now","success_message":"Counsellor will WhatsApp the next steps.","fields":[
         {"id":"student_name","kind":"short_text","label":"Student name","required":true},
         {"id":"parent_phone","kind":"phone","label":"Parent WhatsApp","required":true},
         {"id":"email","kind":"email","label":"Email"},
         {"id":"grade","kind":"select","label":"Class / target","required":true,"options":["Class 8","Class 9","Class 10","Class 11","Class 12","Dropper","IIT-JEE","NEET","CUET","UPSC","Bank PO","CAT / MBA"]},
         {"id":"mode","kind":"radio","label":"Preferred mode","required":true,"options":["Online live","Recorded","Offline (centre)"]},
         {"id":"batch","kind":"select","label":"Batch timing","options":["Weekday morning","Weekday evening","Weekend"]},
         {"id":"counselling","kind":"checkbox","label":"I would like a free 30-min counselling call"}
       ]},
       {"id":"ft","kind":"footer","show_brand_block":true,"show_powered_by":true}
     ]}',
    true, null
  )
on conflict (slug) do nothing;
