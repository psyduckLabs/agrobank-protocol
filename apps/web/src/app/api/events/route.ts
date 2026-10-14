import { fetchEvents } from "@/lib/events";
import { CONTRACT_ID, fail, json, server } from "@/lib/server";

/** Ledger del despliegue en Testnet (deployments/testnet.json). */
const START_LEDGER = Number(process.env.AGROBANK_START_LEDGER || 5182300);

/** Actividad on-chain del contrato, decodificada desde getEvents del RPC. */
export async function GET(request: Request) {
  try {
    const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") || 40), 200);
    const events = await fetchEvents(server(), CONTRACT_ID, START_LEDGER);
    events.sort((a, b) => b.ledger - a.ledger || b.id.localeCompare(a.id));
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const oracle = events.filter((e) => e.type === "oracle_price_used").slice(0, 10);
    return json(
      { total: events.length, counts, events: events.slice(0, limit), oracle },
      200,
      "public, s-maxage=10, stale-while-revalidate=30",
    );
  } catch (e) {
    return fail(e);
  }
}
