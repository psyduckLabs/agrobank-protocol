-- Alinea el espejo off-chain con contracts/agrobank-protocol/src/lib.rs:
-- plazo en ledgers, tasas en bps, split del repago, historial de pignoraciones y auditoría del oráculo.

-- ── Perfiles: CUIT, score de Cartas de Porte y direcciones G… o C… ──
alter table profiles
  add column cuit              text check (cuit ~ '^\d{11}$'),
  add column carta_porte_score integer check (carta_porte_score between 0 and 1000);
alter table profiles drop constraint profiles_wallet_check;
alter table profiles add constraint profiles_wallet_check check (wallet ~ '^[GC][A-Z2-7]{55}$');

-- ── Préstamos: mismos campos que LoanAssignment ──
alter table loans
  add column start_ledger               bigint,                               -- inicio del devengo
  add column interest_rate_bps          integer not null default 1800,        -- ACTIVE_RATE_BPS
  add column investor_yield_bps         integer not null default 1200,        -- PASSIVE_RATE_BPS
  add column repaid_to_pool             numeric(39,0),                        -- LoanRepaid.to_pool
  add column repaid_to_treasury         numeric(39,0),                        -- LoanRepaid.to_treasury
  add column defaulted_expired          boolean,                              -- LoanDefaulted.expired
  add column defaulted_collateral_value numeric(39,0);                        -- LoanDefaulted.collateral_value

alter table loans
  add constraint loans_status_check check (status in ('Active', 'Repaid', 'Defaulted')),
  add constraint loans_term_check   check (start_ledger is null or expiry_ledger > start_ledger),
  add constraint loans_bps_check    check (interest_rate_bps >= investor_yield_bps);

create index loans_status_idx on loans (status);

-- El contrato borra DataKey::Warrant al repagar: un hash puede volver a pignorarse.
-- Unicidad solo mientras el préstamo está Active o Defaulted.
alter table loans drop constraint loans_e_warrant_hash_key;
create unique index loans_warrant_live_uidx on loans (e_warrant_hash)
  where status in ('Active', 'Defaulted');

-- ── Espejo de interest_for(): principal × bps × term / (10_000 × 6_307_200), floor ──
create or replace function agrobank_interest(principal numeric, rate_bps integer, term_ledgers bigint)
returns numeric language sql immutable as $$
  select floor(principal * rate_bps * term_ledgers / (10000::numeric * 6307200))
$$;

-- Cotización de repago por préstamo (split_interest: tesorería = total − inversores)
create view loan_repayment_quotes with (security_invoker = true) as
select q.*,
       q.interest_total - q.interest_investors as spread_treasury,
       q.principal + q.interest_investors       as to_pool,
       q.principal + q.interest_total           as total_due
from (
  select loan_id, farmer, status, principal, start_ledger, expiry_ledger,
         expiry_ledger - start_ledger as term_ledgers,
         agrobank_interest(principal, interest_rate_bps,  expiry_ledger - start_ledger) as interest_total,
         agrobank_interest(principal, investor_yield_bps, expiry_ledger - start_ledger) as interest_investors
  from loans
  where start_ledger is not null
) q;

-- ── Historial de pignoraciones del hash del eWarrant ──
create table warrant_pledges (
  id              bigint generated always as identity primary key,
  e_warrant_hash  text   not null,
  loan_id         bigint not null references loans (loan_id),
  farmer          text   not null,
  pledged_ledger  bigint not null,             -- LoanOriginated
  released_ledger bigint,                      -- LoanRepaid (borra DataKey::Warrant)
  defaulted_ledger bigint,                     -- LoanDefaulted (el hash queda bloqueado)
  created_at      timestamptz not null default now()
);
create index on warrant_pledges (e_warrant_hash);

-- ── Auditoría del oráculo (evento OraclePriceUsed) ──
create table oracle_audit (
  id              bigint generated always as identity primary key,
  chain_event_id  text references chain_events (id),
  tx_hash         text   not null,             -- une con LoanOriginated / LoanDefaulted de la misma tx
  ledger          bigint not null,
  feed_id         bigint not null,
  price           numeric(20,0) not null,      -- i64
  exponent        integer not null,
  publish_time_us bigint not null,
  created_at      timestamptz not null default now()
);
create index on oracle_audit (tx_hash);

-- ── RLS ──
alter table warrant_pledges enable row level security;
alter table oracle_audit    enable row level security;

create policy "own pledges"   on warrant_pledges for select using (farmer = auth.jwt()->>'wallet');
create policy "public oracle" on oracle_audit    for select using (true);

-- Los keepers necesitan ver todos los préstamos activos para liquidar
create policy "keepers see active loans" on loans for select using (
  status = 'Active' and exists (
    select 1 from profiles p
    where p.wallet = auth.jwt()->>'wallet' and 'keeper' = any (p.roles)
  )
);
