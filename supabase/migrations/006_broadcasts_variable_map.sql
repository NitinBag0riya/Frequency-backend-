-- Add variable_map to broadcasts table
ALTER TABLE public.broadcasts ADD COLUMN IF NOT EXISTS variable_map jsonb default '{}'::jsonb;

-- Unique constraint for seed upsert support
ALTER TABLE public.broadcasts DROP CONSTRAINT IF EXISTS broadcasts_user_id_name_unique;
ALTER TABLE public.broadcasts ADD CONSTRAINT broadcasts_user_id_name_unique UNIQUE (user_id, name);
