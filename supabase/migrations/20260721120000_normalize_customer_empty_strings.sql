-- Empty strings in nullable text columns violate CHECK constraints added later
-- (e.g. customers_personal_number_check) and cause any UPDATE to fail with 23514.
UPDATE public.customers
SET personal_number = NULL
WHERE personal_number = '';

UPDATE public.customers
SET email = NULL
WHERE email = '';

UPDATE public.customers
SET org_number = NULL
WHERE org_number = '';

NOTIFY pgrst, 'reload schema';
