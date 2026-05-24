--Harmless SQL command to force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
