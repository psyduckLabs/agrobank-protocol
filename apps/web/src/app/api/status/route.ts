import { Client } from "@agrobank/client";
import { CONTRACT_ID, NETWORK_PASSPHRASE, RPC_URL, VERIFIER_ID, fail, json, marketPrice, server } from "@/lib/server";

/** Estado en vivo del protocolo en Testnet, para la landing. */
export async function GET(request: Request) {
  void request.url; // lectura de la request: se resuelve en cada pedido
  try {
    const c = new Client({ contractId: CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
    const [latest, stats, cfg, market] = await Promise.all([server().getLatestLedger(), c.pool_stats(), c.get_config(), marketPrice()]);
    const [shares, lent] = stats.result as readonly [bigint, bigint, bigint];
    const counts = { Active: 0, Repaid: 0, Defaulted: 0 } as Record<string, number>;
    let loans = 0;
    for (let from = 0; from < 200; from += 20) {
      const r = await Promise.all(
        Array.from({ length: 20 }, (_, i) => c.get_loan({ loan_id: BigInt(from + i) }).then((t) => t.result).catch(() => null)),
      );
      let done = false;
      for (const x of r) {
        const res = x as { isErr?: () => boolean; unwrap?: () => { status: { tag: string } } } | null;
        if (!res || res.isErr?.()) {
          done = true;
          break;
        }
        loans++;
        counts[res.unwrap!().status.tag]++;
      }
      if (done) break;
    }
    const conf = (cfg.result as unknown as { unwrap?: () => Record<string, unknown> }).unwrap?.() ?? {};
    return json(
      {
        network: "testnet",
        ledger: latest.sequence,
        contract: CONTRACT_ID,
        verifier: VERIFIER_ID,
        usdc: String(conf.usdc ?? ""),
        treasury: String(conf.treasury ?? ""),
        pool: { shares: (Number(shares) / 1e7).toFixed(2), lent: (Number(lent) / 1e7).toFixed(2) },
        loans,
        byStatus: counts,
        soyPrice: market.priceUsd,
        soySource: market.source,
        at: new Date().toISOString(),
      },
      200,
      "public, s-maxage=10, stale-while-revalidate=30",
    );
  } catch (e) {
    return fail(e);
  }
}
