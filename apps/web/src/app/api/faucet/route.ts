import { FAUCET_USDC, assertAccount, fail, json, sendTestUsdc } from "@/lib/server";

/** Envía USDC de prueba a una cuenta de Testnet que ya tenga la trustline. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const address = assertAccount(body.address);
    const hash = await sendTestUsdc(address, FAUCET_USDC);
    return json({ hash, amount: FAUCET_USDC });
  } catch (e) {
    return fail(e);
  }
}
