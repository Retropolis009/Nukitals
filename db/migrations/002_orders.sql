CREATE TABLE IF NOT EXISTS orders (
  id varchar(40) PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  customer_name varchar(100) NOT NULL,
  customer_phone varchar(40) NOT NULL,
  customer_email varchar(120),
  delivery_address varchar(500) NOT NULL,
  delivery_city varchar(100) NOT NULL,
  delivery_postal_code varchar(20),
  payment_method varchar(32) NOT NULL CHECK (payment_method IN ('cash_on_delivery', 'jazzcash_manual')),
  payment_status varchar(24) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'due_on_delivery', 'refunded')),
  status varchar(24) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled')),
  note varchar(300) NOT NULL DEFAULT '',
  subtotal numeric(12, 2) NOT NULL CHECK (subtotal >= 0),
  shipping numeric(12, 2) NOT NULL CHECK (shipping >= 0),
  total numeric(12, 2) NOT NULL CHECK (total >= 0)
);

CREATE TABLE IF NOT EXISTS order_items (
  id bigserial PRIMARY KEY,
  order_id varchar(40) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id varchar(40) NOT NULL,
  product_name varchar(160) NOT NULL,
  unit_price numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  line_total numeric(12, 2) NOT NULL CHECK (line_total >= 0)
);

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items(order_id);
