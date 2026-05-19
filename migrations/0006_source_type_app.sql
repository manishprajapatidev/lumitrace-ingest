-- ── Add nodejs, php, python to sources type check ────────────────────────────
ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_type_check;
ALTER TABLE sources
  ADD CONSTRAINT sources_type_check
  CHECK (type IN ('nodejs','php','python','pm2','nginx','apache','journald','file','http',
                  'docker','laravel','mysql','postgresql','syslog'));
