import { PRICE_MAX, PRICE_MIN, fail, json, marketPrice, signPriceUpdate } from "@/lib/server";

/**
 * Oráculo de Testnet (modelo pull): devuelve un update de precio firmado que el
 * contrato `price-verifier` valida on-chain. `?px=` simula un movimiento de mercado
 * para probar liquidaciones; sin parámetro firma el precio de mercado (CBOT).
 */
export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get("px");
    const m = raw === null ? await marketPrice() : null;
    const px = m ? m.priceUsd : Number(raw);
    if (!Number.isFinite(px) || px < PRICE_MIN || px > PRICE_MAX) {
      return json({ error: `El precio simulado tiene que estar entre USD ${PRICE_MIN} y ${PRICE_MAX} por tonelada.` }, 400);
    }
    const u = signPriceUpdate(px);
    return json({ hex: u.hex, priceUsd: u.priceUsd, publishTimeUs: u.publishTimeUs, feedId: u.feedId, simulated: raw !== null, source: m ? m.source : "precio simulado por el keeper" });
  } catch (e) {
    return fail(e);
  }
}
