-- Perprofiles off-chain (el wallet es la identidad)
create table profiles (
  wallet       text primary key check (wallet ~ '^G[A-Z2-7]{55}$'),
  roles        text[] not null default '{}',     -- investor | farmer | keeper
  display_name text,
  email        text,
  kyc_status   text not null default 'none',
  created_at   timestamptz not null default now()
);

-- Eventos crudos del contrato (idempotente por id del RPC)
create table chain_events (
  id          text primary key,
  event_type  text not null,            -- liquidity_deposited, loan_repaid, ...
  ledger      bigint not null,
  tx_hash     text not null,
  occurred_at timestamptz not null,
  wallet      text,                     -- investor / farmer (topic)
  loan_id     bigint,
  amount      numeric(39,0),            -- i128, unidades de 7 decimales
  payload     jsonb not null
);
create index on chain_events (wallet, occurred_at desc);
create index on chain_events (event_type, ledger);

-- Cursor del indexador
create table indexer_state (
  id int primary key default 1 check (id = 1),
  cursor text,
  last_ledger bigint not null,
  updated_at timestamptz not null default now()
);

-- Espejo de préstamos + metadatos off-chain
create table loans (
  loan_id          bigint primary key,
  farmer           text not null,
  principal        numeric(39,0) not null,
  collateral_tonnes numeric not null,
  expiry_ledger    bigint not null,
  e_warrant_hash   text not null unique,
  status           text not null,       -- Active | Repaid | Defaulted
  originated_tx    text,
  updated_at       timestamptz not null default now()
);

-- Documentación legal del eWarrant (el hash on-chain NO reemplaza al documento)
create table ewarrants (
  hash            text primary key,
  farmer_wallet   text not null,
  document_path   text,                 -- Supabase Storage (bucket privado)
  depositario     text,
  grano           text default 'soja',
  toneladas       numeric,
  carta_porte_ref text,
  verified_by_admin boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Serie para gráficos (pool_stats)
create table pool_snapshots (
  ledger bigint primary key,
  total_shares numeric(39,0) not null,
  total_lent   numeric(39,0) not null,
  acc_yield_per_share numeric(39,0) not null,
  taken_at timestamptz not null default now()
);

-- RLS: solo lectura propia; las escrituras las hace el service role (indexador)
alter table profiles       enable row level security;
alter table chain_events   enable row level security;
alter table loans          enable row level security;
alter table ewarrants      enable row level security;
alter table pool_snapshots enable row level security;
alter table indexer_state  enable row level security;

create policy "own profile"  on profiles     for select using (wallet = auth.jwt()->>'wallet');
create policy "own events"   on chain_events for select using (wallet = auth.jwt()->>'wallet');
create policy "own loans"    on loans        for select using (farmer = auth.jwt()->>'wallet');
create policy "own warrants" on ewarrants    for select using (farmer_wallet = auth.jwt()->>'wallet');
create policy "public stats" on pool_snapshots for select using (true);
