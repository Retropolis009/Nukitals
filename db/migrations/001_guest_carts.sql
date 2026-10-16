CREATE TABLE IF NOT EXISTS cart_sessions (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id uuid NOT NULL REFERENCES cart_sessions(id) ON DELETE CASCADE,
  product_id varchar NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  PRIMARY KEY (cart_id, product_id)
);

CREATE INDEX IF NOT EXISTS cart_sessions_expiry_idx ON cart_sessions(expires_at);
