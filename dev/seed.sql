-- A sample shop for working on the UI: several tables, NULLs, long and
-- multi-line text, JSON, blobs, unicode and a few thousand rows, plus the
-- structure the table detail shows: checks, cascading foreign keys, partial
-- and expression indexes, and triggers.
-- Build it with: sqlite3 dev/sample.db < dev/seed.sql

pragma foreign_keys = on;

drop view if exists top_customers;
drop table if exists order_items;
drop table if exists orders;
drop table if exists products;
drop table if exists customers;
drop table if exists events;

create table customers (
    id integer primary key,
    name text not null,
    email text unique,
    city text,
    phone text,
    is_active integer not null default 1,
    balance real not null default 0,
    created_at text not null default (datetime('now')),
    notes text
);

create table products (
    id integer primary key,
    sku text not null unique,
    title text not null,
    category text not null,
    price_cents integer not null,
    stock integer not null default 0,
    attributes text,
    thumbnail blob
);

create table orders (
    id integer primary key,
    customer_id integer not null references customers(id),
    status text not null check (status in ('pending', 'paid', 'shipped', 'cancelled')),
    total_cents integer not null default 0,
    placed_at text not null,
    shipped_at text,
    updated_at text
);

create table order_items (
    order_id integer not null references orders(id) on delete cascade,
    product_id integer not null references products(id) on update cascade on delete cascade,
    quantity integer not null check (quantity > 0),
    unit_cents integer not null,
    primary key (order_id, product_id)
);

create table events (
    id integer primary key,
    kind text not null,
    payload text,
    at text not null
);

with recursive n(i) as (select 1 union all select i + 1 from n where i < 1200)
insert into customers (name, email, city, phone, is_active, balance, created_at, notes)
select
    case i % 9
        when 0 then 'Abebe Kebede' when 1 then 'Sara Tesfaye' when 2 then 'ሀይሉ መንግስቱ'
        when 3 then 'Liya Haile' when 4 then 'Dawit Alemu' when 5 then 'Mahlet Girma'
        when 6 then 'Yonas Bekele' when 7 then 'Selam Worku' else 'Nahom Tadesse'
    end || ' ' || i,
    case when i % 13 = 0 then null else 'user' || i || '@example.com' end,
    case i % 6 when 0 then 'Addis Ababa' when 1 then 'Adama' when 2 then 'Bahir Dar'
        when 3 then 'Hawassa' when 4 then 'Mekelle' else null end,
    case when i % 4 = 0 then null else '+2519' || printf('%08d', (i * 7919) % 100000000) end,
    i % 10 <> 0,
    round(((i * 37) % 5000) / 3.0 - 400, 2),
    datetime('2025-01-01', '+' || ((i * 7) % 600) || ' days', '+' || ((i * 13) % 1440) || ' minutes'),
    case i % 25
        when 0 then 'Prefers delivery after 6pm.' || char(10) || 'Gate code 4471.'
        when 1 then 'VIP: ' || replace(hex(zeroblob(40)), '00', 'ab')
        else null
    end
from n;

with recursive n(i) as (select 1 union all select i + 1 from n where i < 180)
insert into products (sku, title, category, price_cents, stock, attributes, thumbnail)
select
    'SKU-' || printf('%05d', i),
    case i % 6 when 0 then 'Buna coffee beans' when 1 then 'Injera mitad' when 2 then 'Habesha kemis'
        when 3 then 'Berbere spice mix' when 4 then 'Jebena clay pot' else 'Netela scarf' end || ' #' || i,
    case i % 4 when 0 then 'food' when 1 then 'kitchen' when 2 then 'clothing' else 'gifts' end,
    500 + (i * 997) % 20000,
    (i * 31) % 250,
    json_object('color', case i % 3 when 0 then 'red' when 1 then 'green' else 'yellow' end, 'weight_g', (i * 53) % 2000, 'tags', json_array('new', 'local')),
    case when i % 5 = 0 then randomblob(16) else null end
from n;

with recursive n(i) as (select 1 union all select i + 1 from n where i < 4000)
insert into orders (customer_id, status, total_cents, placed_at, shipped_at)
select
    1 + (i * 7) % 1200,
    case i % 7 when 0 then 'cancelled' when 1 then 'pending' when 2 then 'paid' else 'shipped' end,
    0,
    datetime('2025-03-01', '+' || ((i * 3) % 540) || ' days'),
    case when i % 7 > 2 then datetime('2025-03-03', '+' || ((i * 3) % 540) || ' days') else null end
from n;

with recursive n(i) as (select 1 union all select i + 1 from n where i < 9000)
insert or ignore into order_items (order_id, product_id, quantity, unit_cents)
select 1 + (i * 11) % 4000, 1 + (i * 17) % 180, 1 + i % 4, 500 + (i * 997) % 20000
from n;

update orders set total_cents = (select coalesce(sum(quantity * unit_cents), 0) from order_items where order_id = orders.id);

with recursive n(i) as (select 1 union all select i + 1 from n where i < 2500)
insert into events (kind, payload, at)
select
    case i % 5 when 0 then 'signin' when 1 then 'search' when 2 then 'cart.add' when 3 then 'checkout' else 'error' end,
    json_object('session', lower(hex(randomblob(6))), 'ms', (i * 37) % 900),
    datetime('2025-06-01', '+' || (i * 17) || ' minutes')
from n;

create view top_customers as
select c.id, c.name, c.city, count(o.id) as orders, sum(o.total_cents) / 100.0 as spent
from customers c join orders o on o.customer_id = c.id
where o.status <> 'cancelled'
group by c.id
order by spent desc;

create index orders_customer on orders (customer_id);
create index orders_pending on orders (placed_at) where status = 'pending';
create index customers_email_lower on customers (lower(email));
create index events_kind on events (kind, at);

-- Created after the bulk load so the seed itself does not fire them.
create trigger orders_touch after update on orders for each row
begin
    update orders set updated_at = datetime('now') where id = new.id;
end;

create trigger orders_audit after insert on orders for each row
begin
    insert into events (kind, payload, at)
    values ('order.created', json_object('order', new.id, 'customer', new.customer_id), datetime('now'));
end;
analyze;
