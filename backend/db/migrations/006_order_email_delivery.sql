ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email_sent_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_email_sent_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_attempts integer NOT NULL DEFAULT 0;
