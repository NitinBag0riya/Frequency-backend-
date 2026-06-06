-- 20260607020000_knowledge_source_document
-- Allow uploaded documents (PDF/DOCX/TXT/MD/CSV) as a knowledge source.
--
-- Migration 066 constrained source_type to
-- ('qa_wizard','conversation','manual','wa_profile','product'). The AI
-- Responder's /settings/ai page now supports document upload, which stores
-- chunks with source_type='document'. Extend the CHECK to permit it.

alter table public.tenant_knowledge_chunks
  drop constraint if exists tenant_knowledge_chunks_source_type_check;

alter table public.tenant_knowledge_chunks
  add constraint tenant_knowledge_chunks_source_type_check
  check (source_type in ('qa_wizard','conversation','manual','wa_profile','product','document'));
