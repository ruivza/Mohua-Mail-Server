CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),email TEXT NOT NULL,mode TEXT NOT NULL,imap_host TEXT NOT NULL,imap_port INTEGER NOT NULL,smtp_host TEXT NOT NULL,smtp_port INTEGER NOT NULL,credential TEXT NOT NULL,monitor_enabled INTEGER NOT NULL DEFAULT 1,UNIQUE(user_id,email));
CREATE TABLE IF NOT EXISTS administrators(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_sessions(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES administrators(id),token_hash TEXT UNIQUE NOT NULL,name TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS client_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,platform TEXT NOT NULL,created BIGINT NOT NULL,revoked BIGINT,push_token TEXT,push_environment TEXT,push_token_hash TEXT,push_registered BIGINT NOT NULL DEFAULT 0,push_last_sent BIGINT NOT NULL DEFAULT 0,push_error TEXT,push_enabled INTEGER NOT NULL DEFAULT 1,push_credential TEXT,push_not_before BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS device_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,device_id TEXT NOT NULL REFERENCES client_devices(id));
CREATE TABLE IF NOT EXISTS mailbox_revisions(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,revision BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS device_mailboxes(device_id TEXT NOT NULL REFERENCES client_devices(id),account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,acked BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(device_id,account_id));
CREATE TABLE IF NOT EXISTS push_settings(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL,custom_url TEXT,revision TEXT NOT NULL,server_id TEXT NOT NULL,official_url TEXT);
CREATE TABLE IF NOT EXISTS push_jobs(device_id TEXT PRIMARY KEY REFERENCES client_devices(id) ON DELETE CASCADE,generation BIGINT NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,next_at BIGINT NOT NULL,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_id TEXT NOT NULL,request_key TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created BIGINT NOT NULL,UNIQUE(user_id,request_key));
CREATE TABLE IF NOT EXISTS service_samples(at BIGINT PRIMARY KEY,api TEXT,db TEXT,worker TEXT,latency DOUBLE PRECISION,memory DOUBLE PRECISION,cpu DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS selftest_runs(id TEXT PRIMARY KEY,started BIGINT,status TEXT,stage TEXT,duration BIGINT,detail TEXT);
CREATE TABLE IF NOT EXISTS service_settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS health_probe(id INTEGER PRIMARY KEY,value BIGINT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS devices_user ON client_devices(user_id);
CREATE INDEX IF NOT EXISTS accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS push_due ON push_jobs(next_at);
CREATE TABLE IF NOT EXISTS encryption_check(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS outbox_created ON outbox(created);

ALTER TABLE client_devices ADD COLUMN IF NOT EXISTS push_alerts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sync';
ALTER TABLE push_jobs ADD COLUMN IF NOT EXISTS alert_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE push_jobs ADD COLUMN IF NOT EXISTS notification TEXT;
ALTER TABLE client_devices ADD COLUMN IF NOT EXISTS notification_key TEXT;
ALTER TABLE client_devices ADD COLUMN IF NOT EXISTS push_credential_hash TEXT;

-- Enable background monitoring once for existing mailboxes, without overriding
-- later administrative changes on every server restart.
ALTER TABLE accounts ALTER COLUMN monitor_enabled SET DEFAULT 1;
CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY);
WITH migration AS (
  INSERT INTO schema_migrations(name) VALUES ('default-mailbox-monitoring-v1')
  ON CONFLICT DO NOTHING RETURNING name
)
UPDATE accounts SET monitor_enabled=1
WHERE mode='proxy' AND monitor_enabled=0 AND EXISTS (SELECT 1 FROM migration);

-- Sync archives have an independent identity and never follow IMAP deletion.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_credential TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'off';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sync_updated BIGINT;
CREATE TABLE IF NOT EXISTS archive_folders(
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  path TEXT NOT NULL, name TEXT NOT NULL, special_use TEXT,
  validity TEXT NOT NULL, next_uid BIGINT NOT NULL DEFAULT 1,
  cursor TEXT, PRIMARY KEY(account_id,path)
);
CREATE TABLE IF NOT EXISTS archive_messages(
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, folder TEXT NOT NULL,
  source_validity TEXT NOT NULL, source_uid BIGINT NOT NULL,
  uid BIGINT, sort_time BIGINT NOT NULL DEFAULT 0, metadata TEXT NOT NULL, flags TEXT NOT NULL,
  manifest TEXT, expected_parts TEXT NOT NULL, archived_at BIGINT,
  FOREIGN KEY(account_id,folder) REFERENCES archive_folders(account_id,path) ON DELETE RESTRICT,
  UNIQUE(account_id,folder,source_validity,source_uid), UNIQUE(account_id,folder,uid)
);
CREATE TABLE IF NOT EXISTS archive_chunks(
  message_id TEXT NOT NULL REFERENCES archive_messages(id) ON DELETE CASCADE,
  part TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(message_id,part,seq)
);
CREATE INDEX IF NOT EXISTS archive_message_date ON archive_messages(account_id,folder,sort_time DESC,uid DESC) WHERE uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS archive_message_page ON archive_messages(account_id,folder,uid) WHERE uid IS NOT NULL;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deletion_requested_at BIGINT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS purge_after BIGINT;
CREATE INDEX IF NOT EXISTS accounts_purge_due ON accounts(purge_after) WHERE purge_after IS NOT NULL;
CREATE TABLE IF NOT EXISTS remote_drafts(
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  id TEXT NOT NULL, revision TEXT, deleted_at BIGINT, updated BIGINT NOT NULL,
  PRIMARY KEY(account_id,id)
);
CREATE TABLE IF NOT EXISTS remote_draft_versions(
  account_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision TEXT NOT NULL,
  chunks INTEGER NOT NULL, created BIGINT NOT NULL,
  PRIMARY KEY(account_id,draft_id,revision),
  FOREIGN KEY(account_id,draft_id) REFERENCES remote_drafts(account_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS remote_draft_chunks(
  account_id TEXT NOT NULL,draft_id TEXT NOT NULL,revision TEXT NOT NULL,
  seq INTEGER NOT NULL,payload TEXT NOT NULL,
  PRIMARY KEY(account_id,draft_id,revision,seq),
  FOREIGN KEY(account_id,draft_id,revision) REFERENCES remote_draft_versions(account_id,draft_id,revision) ON DELETE CASCADE
);

ALTER TABLE archive_messages ADD COLUMN IF NOT EXISTS message_hash TEXT;
ALTER TABLE remote_drafts ADD COLUMN IF NOT EXISTS send_id TEXT;
CREATE INDEX IF NOT EXISTS archive_sent_identity ON archive_messages(account_id,message_hash) WHERE uid IS NOT NULL;

-- Credentials are absent while unbound; archive encryption is independent.
ALTER TABLE accounts ALTER COLUMN credential DROP NOT NULL;
ALTER TABLE remote_draft_versions ADD COLUMN IF NOT EXISTS storage_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE remote_draft_versions ADD COLUMN IF NOT EXISTS expected_files TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS mail_file_store(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mail_files(
  id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  message_id TEXT REFERENCES archive_messages(id) ON DELETE CASCADE,
  draft_id TEXT,revision TEXT,part TEXT NOT NULL,created BIGINT NOT NULL,
  FOREIGN KEY(account_id,draft_id,revision) REFERENCES remote_draft_versions(account_id,draft_id,revision) ON DELETE CASCADE,
  UNIQUE(message_id,part),UNIQUE(account_id,draft_id,revision,part),
  CHECK((message_id IS NOT NULL AND draft_id IS NULL AND revision IS NULL) OR (message_id IS NULL AND draft_id IS NOT NULL AND revision IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS mail_file_chunks(
  file_id TEXT NOT NULL REFERENCES mail_files(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(file_id,seq)
);
CREATE TABLE IF NOT EXISTS mail_file_deletions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL);
CREATE OR REPLACE FUNCTION queue_mail_file_deletion() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO mail_file_deletions(id,account_id) VALUES(OLD.id,OLD.account_id) ON CONFLICT DO NOTHING;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS queue_mail_file_deletion ON mail_files;
CREATE TRIGGER queue_mail_file_deletion AFTER DELETE ON mail_files FOR EACH ROW EXECUTE FUNCTION queue_mail_file_deletion();

-- Upgrade already-pending deletions from the previous credential-retaining flow.
UPDATE accounts SET credential=NULL,sync_credential=NULL,monitor_enabled=0 WHERE purge_after IS NOT NULL;

-- Persistent first-observation boundary separates historical imports from new arrivals.
ALTER TABLE archive_folders ADD COLUMN IF NOT EXISTS arrival_validity TEXT;
ALTER TABLE archive_folders ADD COLUMN IF NOT EXISTS arrival_floor BIGINT;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS writeback_enabled INTEGER NOT NULL DEFAULT 1;
-- Existing mailbox preferences are preserved; new mailboxes default to writeback.
ALTER TABLE accounts ALTER COLUMN writeback_enabled SET DEFAULT 1;
ALTER TABLE archive_messages ADD COLUMN IF NOT EXISTS source_folder TEXT;
UPDATE archive_messages SET source_folder=folder WHERE source_folder IS NULL;
ALTER TABLE archive_messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
DO $$ DECLARE c RECORD; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='archive_messages'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (account_id, folder, source_validity, source_uid)' LOOP
 EXECUTE format('ALTER TABLE archive_messages DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS mailbox_source_links(
 account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,folder TEXT NOT NULL,validity TEXT NOT NULL,uid BIGINT NOT NULL,
 message_id TEXT REFERENCES archive_messages(id) ON DELETE SET NULL,PRIMARY KEY(account_id,folder,validity,uid)
);
INSERT INTO mailbox_source_links SELECT account_id,source_folder,source_validity,source_uid,id FROM archive_messages ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS mailbox_writebacks(
 id TEXT PRIMARY KEY,sequence BIGSERIAL UNIQUE,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES archive_messages(id) ON DELETE CASCADE,action TEXT NOT NULL,destination TEXT,
 state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at BIGINT NOT NULL DEFAULT 0
);

-- Referencing-side indexes for foreign keys and account cleanup. Without them every deleted
-- archive message scans both link tables, and large mailbox purges exceed statement_timeout.
CREATE INDEX IF NOT EXISTS source_links_message ON mailbox_source_links(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS writebacks_message ON mailbox_writebacks(message_id);
CREATE INDEX IF NOT EXISTS device_mailboxes_account ON device_mailboxes(account_id);
CREATE INDEX IF NOT EXISTS outbox_account ON outbox(account_id);
