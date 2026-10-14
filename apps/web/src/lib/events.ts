// Decodificador de los eventos #[contractevent] de lib.rs. Lo usan /api/events y
// el indexador (scripts/indexer.ts). Topic 0: nombre en snake_case; topic 1: el
// campo #[topic]; value: mapa con el resto de los campos.
import { rpc, scValToNative } from "@agrobank/client";

export type EventType =
  | "liquidity_deposited"
  | "liquidity_withdrawn"
  | "yield_claimed"
  | "loan_originated"
  | "loan_repaid"
  | "loan_defaulted"
  | "oracle_price_used";

export interface AgroEvent {
  id: string;
  type: EventType | string;
  ledger: number;
  txHash: string;
  at: string;
  wallet: string | null;
  loanId: number | null;
  amount: string | null; // i128 en unidades de 7 decimales
  data: Record<string, string | number | boolean>;
}

const plain = (v: unknown): string | number | boolean => {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return String(v);
};

export function decodeEvent(e: rpc.Api.EventResponse): AgroEvent {
  const topics = e.topic.map((t) => scValToNative(t));
  const type = String(topics[0]);
  const raw = (scValToNative(e.value) ?? {}) as Record<string, unknown>;
  const data: AgroEvent["data"] = {};
  for (const [k, v] of Object.entries(raw)) data[k] = plain(v);
  const key = topics[1];
  const byInvestor = type === "liquidity_deposited" || type === "liquidity_withdrawn" || type === "yield_claimed";
  const byLoan = type.startsWith("loan_");
  if (byInvestor) data.investor = String(key);
  if (byLoan) data.loan_id = Number(key);
  if (type === "oracle_price_used") data.feed_id = Number(key);
  const amount =
    type === "loan_originated" ? data.principal : type === "loan_repaid" ? data.to_pool : type === "loan_defaulted" ? data.collateral_value : data.amount;
  return {
    id: e.id,
    type,
    ledger: e.ledger,
    txHash: e.txHash,
    at: e.ledgerClosedAt,
    wallet: byInvestor ? String(key) : type === "loan_originated" ? String(data.farmer) : null,
    loanId: byLoan ? Number(key) : null,
    amount: amount === undefined ? null : String(amount),
    data,
  };
}

/** Lee todos los eventos del contrato desde `startLedger`, paginando por cursor. */
export async function fetchEvents(server: rpc.Server, contractId: string, startLedger: number, max = 2000): Promise<AgroEvent[]> {
  const out: AgroEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50 && out.length < max; page++) {
    const req = cursor
      ? { filters: [{ type: "contract" as const, contractIds: [contractId] }], cursor, limit: 200 }
      : { filters: [{ type: "contract" as const, contractIds: [contractId] }], startLedger, limit: 200 };
    const r = await server.getEvents(req);
    for (const e of r.events) out.push(decodeEvent(e));
    if (r.events.length < 200) break;
    cursor = r.cursor;
  }
  return out;
}
