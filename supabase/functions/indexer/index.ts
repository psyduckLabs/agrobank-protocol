// Edge Function: indexador continuo de AgroBank dentro de Supabase.
// Lee los eventos del contrato en Stellar Testnet (getEvents), los vuelca al esquema
// de supabase/migrations y guarda un snapshot del pool. Lo dispara pg_cron.
// Usa SUPABASE_DB_URL, que Supabase inyecta en el entorno de la función.
import postgres from "npm:postgres@3.4.5";
import { contract, rpc, scValToNative } from "npm:@stellar/stellar-sdk@14.2.0";

const RPC_URL = Deno.env.get("SOROBAN_RPC_URL") ?? "https://soroban-testnet.stellar.org";
const NP = "Test SDF Network ; September 2015";
const CONTRACT = Deno.env.get("AGROBANK_CONTRACT_ID") ?? "CCSDZ5BGMZPUNIOLGSTXW7R3M3FYCPB2RZU4V3P664245ZH2KAYPFGGG";
const START = 5182300;

type Plain = string | number | boolean;
const plain = (v: unknown): Plain =>
  typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("") :
  typeof v === "number" || typeof v === "boolean" || typeof v === "string" ? v : String(v);

function decode(e: rpc.Api.EventResponse) {
  const topics = e.topic.map((t) => scValToNative(t));
  const type = String(topics[0]);
  const raw = (scValToNative(e.value) ?? {}) as Record<string, unknown>;
  const d: Record<string, Plain> = {};
  for (const [k, v] of Object.entries(raw)) d[k] = plain(v);
  const key = topics[1];
  const byInvestor = ["liquidity_deposited", "liquidity_withdrawn", "yield_claimed"].includes(type);
  const byLoan = type.startsWith("loan_");
  if (byInvestor) d.investor = String(key);
  if (byLoan) d.loan_id = Number(key);
  if (type === "oracle_price_used") d.feed_id = Number(key);
  const amount = type === "loan_originated" ? d.principal : type === "loan_repaid" ? d.to_pool : type === "loan_defaulted" ? d.collateral_value : d.amount;
  return {
    id: e.id, type, ledger: e.ledger, txHash: e.txHash, at: e.ledgerClosedAt, d,
    wallet: byInvestor ? String(key) : type === "loan_originated" ? String(d.farmer) : null,
    loanId: byLoan ? Number(key) : null,
    amount: amount === undefined ? null : String(amount),
  };
}

Deno.serve(async () => {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
  try {
    const server = new rpc.Server(RPC_URL);
    // deno-lint-ignore no-explicit-any
    const bank: any = await contract.Client.from({ contractId: CONTRACT, networkPassphrase: NP, rpcUrl: RPC_URL });
    const getLoan = async (id: number) => (await bank.get_loan({ loan_id: BigInt(id) })).result.unwrap();

    const st = await sql`select last_ledger from indexer_state where id = 1`;
    const latest = await server.getLatestLedger();
    // la retención del RPC es acotada: no pedir más atrás que ~6 días
    const from = Math.max(st[0] ? Number(st[0].last_ledger) : START, latest.sequence - 100_000);

    const events: ReturnType<typeof decode>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const filters = [{ type: "contract" as const, contractIds: [CONTRACT] }];
      const r = await server.getEvents(cursor ? { filters, cursor, limit: 200 } : { filters, startLedger: from, limit: 200 });
      events.push(...r.events.map(decode));
      if (r.events.length < 200) break;
      cursor = r.cursor;
    }
    events.sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));

    let applied = 0;
    for (const e of events) {
      await sql.begin(async (tx) => {
        const ins = await tx`insert into chain_events (id, event_type, ledger, tx_hash, occurred_at, wallet, loan_id, amount, payload)
          values (${e.id}, ${e.type}, ${e.ledger}, ${e.txHash}, ${e.at}, ${e.wallet}, ${e.loanId}, ${e.amount}, ${tx.json(e.d)})
          on conflict (id) do nothing returning id`;
        if (ins.length === 0) return;
        applied++;
        const d = e.d;
        if (e.type === "loan_originated") {
          const l = await getLoan(e.loanId!);
          const hash = Array.from(l.e_warrant_hash as Uint8Array, (b: number) => b.toString(16).padStart(2, "0")).join("");
          await tx`insert into loans (loan_id, farmer, principal, collateral_tonnes, expiry_ledger, e_warrant_hash, status,
                     originated_tx, start_ledger, interest_rate_bps, investor_yield_bps)
                   values (${e.loanId}, ${String(d.farmer)}, ${String(d.principal)}, ${l.collateral_tonnes.toString()}, ${l.expiry_ledger},
                     ${hash}, 'Active', ${e.txHash}, ${l.start_ledger}, ${l.interest_rate_bps}, ${l.investor_yield_bps})
                   on conflict (loan_id) do nothing`;
          await tx`insert into warrant_pledges (e_warrant_hash, loan_id, farmer, pledged_ledger) values (${hash}, ${e.loanId}, ${String(d.farmer)}, ${e.ledger})`;
        } else if (e.type === "loan_repaid") {
          await tx`update loans set status = 'Repaid', repaid_to_pool = ${String(d.to_pool)}, repaid_to_treasury = ${String(d.to_treasury)}, updated_at = now() where loan_id = ${e.loanId}`;
          await tx`update warrant_pledges set released_ledger = ${e.ledger} where loan_id = ${e.loanId}`;
        } else if (e.type === "loan_defaulted") {
          await tx`update loans set status = 'Defaulted', defaulted_expired = ${Boolean(d.expired)}, defaulted_collateral_value = ${String(d.collateral_value)}, updated_at = now() where loan_id = ${e.loanId}`;
          await tx`update warrant_pledges set defaulted_ledger = ${e.ledger} where loan_id = ${e.loanId}`;
        } else if (e.type === "oracle_price_used") {
          await tx`insert into oracle_audit (chain_event_id, tx_hash, ledger, feed_id, price, exponent, publish_time_us)
                   values (${e.id}, ${e.txHash}, ${e.ledger}, ${d.feed_id}, ${String(d.price)}, ${d.exponent}, ${String(d.publish_time_us)})`;
        }
      });
    }

    const [shares, lent, acc] = (await bank.pool_stats()).result as [bigint, bigint, bigint];
    await sql`insert into pool_snapshots (ledger, total_shares, total_lent, acc_yield_per_share)
              values (${latest.sequence}, ${shares.toString()}, ${lent.toString()}, ${acc.toString()}) on conflict do nothing`;
    await sql`insert into indexer_state (id, last_ledger) values (1, ${latest.sequence})
              on conflict (id) do update set last_ledger = ${latest.sequence}, updated_at = now()`;
    const lentDb = (await sql`select coalesce(sum(principal), 0)::text s from loans where status in ('Active', 'Defaulted')`)[0].s;
    const body = { ok: true, read: events.length, applied, ledger: latest.sequence, totalLentDb: lentDb, totalLentChain: lent.toString(), match: lentDb === lent.toString() };
    return Response.json(body);
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  } finally {
    await sql.end();
  }
});
