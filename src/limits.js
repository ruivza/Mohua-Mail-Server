// Named time spans and limits shared across modules. Values are milliseconds unless the name says otherwise.
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const MAX_UID = 4294967295;
export const CHUNK_BYTES = 65536;
export const CHUNK_BATCH = 8;

export const SESSION_TTL = 30 * DAY;
export const ADMIN_SESSION_TTL = DAY;
export const INVITE_TTL = DAY;
export const CHALLENGE_TTL = 5 * MINUTE;
export const VERIFICATION_TTL = 5 * MINUTE;
export const RECOVERY_PERIOD = 30 * DAY;
export const OUTBOX_RETENTION = 90 * DAY;
export const LEASE_MAX_LIFETIME = 366 * DAY;

export const WORKER_HEARTBEAT = 10 * SECOND;
export const WORKER_REGISTRATION = 15 * SECOND;

export const MAX_DEVICES_PER_USER = 20;
export const LOGIN_ATTEMPTS_PER_MINUTE = 20;
export const MAIL_REQUESTS_PER_MINUTE = 120;

export const JSON_BODY_BYTES = 16384;
export const OUTBOX_BODY_BYTES = 400000;
export const DRAFT_BODY_BYTES = 37 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_MIME_BYTES = 40 * 1024 * 1024;

// Mail operation concurrency: per user and process-wide ceilings (constructor options override).
export const SEND_ACTIVE_PER_USER = 1;
export const SEND_ACTIVE_TOTAL = 8;
export const SEND_PENDING_PER_USER = 4;
export const SEND_PENDING_TOTAL = 128;
export const READ_JOBS_PER_USER = 2;
export const READ_JOBS_TOTAL = 64;
