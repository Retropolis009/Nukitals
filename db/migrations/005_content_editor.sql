CREATE TABLE IF NOT EXISTS site_content (
  content_key varchar(80) PRIMARY KEY,
  content_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_content (
  product_id varchar(40) PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  subtitle varchar(500) NOT NULL DEFAULT '',
  size varchar(100) NOT NULL DEFAULT '',
  gallery jsonb NOT NULL DEFAULT '[]'::jsonb,
  eyebrow varchar(200) NOT NULL DEFAULT '',
  intro varchar(2000) NOT NULL DEFAULT '',
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
