ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash varchar(64);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_sent boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uidx
  ON orders (idempotency_key);
