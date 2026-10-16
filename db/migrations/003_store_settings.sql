CREATE TABLE IF NOT EXISTS store_settings (
  key varchar(80) PRIMARY KEY,
  value numeric(12, 2) NOT NULL CHECK (value >= 0)
);

INSERT INTO store_settings (key, value)
VALUES ('delivery_fee', 350)
ON CONFLICT (key) DO NOTHING;
