// Indexador: eventos del contrato (RPC getEvents) → esquema de supabase/migrations.
// Después reconcilia la base contra el contrato on-chain (roadmap, fase 4).
//
//   DATABASE_URL=postgres://… node scripts/indexer.ts [--reconcile-out ruta.json]
//
// Sirve con Supabase (connection string del proyecto) o con cualquier Postgres
// con las migraciones aplicadas. Es idempotente: se puede correr en cron.
import { writeFileSync } from "node:fs";
import pg from "pg";
import { Client, rpc } from "@agrobank/client";
import { fetchEvents, type AgroEvent } from "../src/lib/events.ts";

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NP = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const CONTRACT = process.env.NEXT_PUBLIC_AGROBANK_CONTRACT_ID!;
const START = Number(process.env.AGROBANK_START_LEDGER || 5182300);
const outIdx = process.argv.indexOf("--reconcile-out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : null;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const server = new rpc.Server(RPC_URL);
const bank = new Client({ contractId: CONTRACT, networkPassphrase: NP, rpcUrl: RPC_URL });

type Loan = {
  farmer_address: string;
  principal_usd: bigint;
  collateral_tonnes: bigint;
  start_ledger: number;
  expiry_ledger: number;
  e_warrant_hash: Uint8Array;
  interest_rate_bps: number;
  investor_yield_bps: number;
  status: { tag: string };
};
async function getLoan(id: number): Promise<Loan> {
  const t = await bank.get_loan({ loan_id: BigInt(id) });
  return (t.result as unknown as { unwrap: () => Loan }).unwrap();
}

async function apply(e: AgroEvent) {
  const d = e.data;
  const inserted = await db.query(
    `insert into chain_events (id, event_type, ledger, tx_hash, occurred_at, wallet, loan_id, amount, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (id) do nothing`,
    [e.id, e.type, e.ledger, e.txHash, e.at, e.wallet, e.loanId, e.amount, JSON.stringify(d)],
  );
  if (inserted.rowCount === 0) return false; // ya indexado
  switch (e.type) {
    case "loan_originated": {
      const l = await getLoan(e.loanId!);
      const hash = Buffer.from(l.e_warrant_hash).toString("hex");
      await db.query(
        `insert into loans (loan_id, farmer, principal, collateral_tonnes, expiry_ledger, e_warrant_hash, status,
                            originated_tx, start_ledger, interest_rate_bps, investor_yield_bps)
         values ($1,$2,$3,$4,$5,$6,'Active',$7,$8,$9,$10) on conflict (loan_id) do nothing`,
        [e.loanId, String(d.farmer), String(d.principal), l.collateral_tonnes.toString(), l.expiry_ledger, hash, e.txHash,
         l.start_ledger, l.interest_rate_bps, l.investor_yield_bps],
      );
      await db.query(
        `insert into warrant_pledges (e_warrant_hash, loan_id, farmer, pledged_ledger) values ($1,$2,$3,$4)`,
        [hash, e.loanId, String(d.farmer), e.ledger],
      );
      break;
    }
    case "loan_repaid":
      await db.query(
        `update loans set status='Repaid', repaid_to_pool=$2, repaid_to_treasury=$3, updated_at=now() where loan_id=$1`,
        [e.loanId, String(d.to_pool), String(d.to_treasury)],
      );
      await db.query(`update warrant_pledges set released_ledger=$2 where loan_id=$1`, [e.loanId, e.ledger]);
      break;
    case "loan_defaulted":
      await db.query(
        `update loans set status='Defaulted', defaulted_expired=$2, defaulted_collateral_value=$3, updated_at=now() where loan_id=$1`,
        [e.loanId, Boolean(d.expired), String(d.collateral_value)],
      );
      await db.query(`update warrant_pledges set defaulted_ledger=$2 where loan_id=$1`, [e.loanId, e.ledger]);
      break;
    case "oracle_price_used":
      await db.query(
        `insert into oracle_audit (chain_event_id, tx_hash, ledger, feed_id, price, exponent, publish_time_us)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [e.id, e.txHash, e.ledger, d.feed_id, String(d.price), d.exponent, String(d.publish_time_us)],
      );
      break;
  }
  return true;
}

async function main() {
  await db.connect();
  const st = await db.query(`select last_ledger from indexer_state where id=1`);
  const from = st.rows[0] ? Number(st.rows[0].last_ledger) : START;
  const events = await fetchEvents(server, CONTRACT, from);
  // orden de la red: un loan_originated siempre antes que su repago o liquidación
  events.sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
  let applied = 0;
  for (const e of events) {
    await db.query("begin");
    try {
      if (await apply(e)) applied++;
      await db.query("commit");
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  }
  const latest = await server.getLatestLedger();
  const [shares, lent, acc] = (await bank.pool_stats()).result as unknown as [bigint, bigint, bigint];
  await db.query(
    `insert into pool_snapshots (ledger, total_shares, total_lent, acc_yield_per_share) values ($1,$2,$3,$4) on conflict do nothing`,
    [latest.sequence, shares.toString(), lent.toString(), acc.toString()],
  );
  await db.query(
    `insert into indexer_state (id, last_ledger) values (1,$1) on conflict (id) do update set last_ledger=$1, updated_at=now()`,
    [latest.sequence],
  );
  console.log(`eventos leídos ${events.length}, aplicados ${applied}, ledger ${latest.sequence}`);

  // ── Reconciliación: base vs. contrato ──
  const diffs: string[] = [];
  const rows = (await db.query(`select * from loans order by loan_id`)).rows;
  for (const r of rows) {
    const l = await getLoan(Number(r.loan_id));
    const chk = (campo: string, a: unknown, b: unknown) => {
      if (String(a) !== String(b)) diffs.push(`loan ${r.loan_id}: ${campo} db=${a} chain=${b}`);
    };
    chk("status", r.status, l.status.tag);
    chk("farmer", r.farmer, l.farmer_address);
    chk("principal", r.principal, l.principal_usd);
    chk("start_ledger", r.start_ledger, l.start_ledger);
    chk("expiry_ledger", r.expiry_ledger, l.expiry_ledger);
    chk("e_warrant_hash", r.e_warrant_hash, Buffer.from(l.e_warrant_hash).toString("hex"));
  }
  // la fórmula SQL (agrobank_interest) contra lo que el contrato efectivamente transfirió
  const q = (await db.query(
    `select q.loan_id, q.to_pool, q.spread_treasury, l.repaid_to_pool, l.repaid_to_treasury
       from loan_repayment_quotes q join loans l using (loan_id) where l.status='Repaid'`,
  )).rows;
  for (const r of q) {
    if (String(r.to_pool) !== String(r.repaid_to_pool)) diffs.push(`loan ${r.loan_id}: to_pool SQL=${r.to_pool} chain=${r.repaid_to_pool}`);
    if (String(r.spread_treasury) !== String(r.repaid_to_treasury)) diffs.push(`loan ${r.loan_id}: spread SQL=${r.spread_treasury} chain=${r.repaid_to_treasury}`);
  }
  const lentDb = (await db.query(`select coalesce(sum(principal),0) s from loans where status in ('Active','Defaulted')`)).rows[0].s;
  if (String(lentDb) !== lent.toString()) diffs.push(`total_lent db=${lentDb} chain=${lent}`);
  const counts = (await db.query(`select event_type, count(*)::int n from chain_events group by 1 order by 1`)).rows;
  const oracle = (await db.query(`select count(*)::int n from oracle_audit`)).rows[0].n;

  const report = {
    at: new Date().toISOString(),
    ledger: latest.sequence,
    loans: rows.length,
    repaidChecked: q.length,
    oracleAudit: oracle,
    events: Object.fromEntries(counts.map((c) => [c.event_type, c.n])),
    totalLent: lent.toString(),
    differences: diffs,
    ok: diffs.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  await db.end();
  if (diffs.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await db.end().catch(() => {});
  process.exit(1);
});
