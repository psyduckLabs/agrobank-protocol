import { Client } from "@agrobank/client";
import { rpc } from "@agrobank/client";
import { explainError } from "@/lib/chain";
import {
  CONTRACT_ID,
  DAY_IN_LEDGERS,
  HttpError,
  MAX_DAYS,
  MAX_PRINCIPAL_USDC,
  MAX_TONNES,
  NETWORK_PASSPHRASE,
  REFERENCE_PRICE,
  RPC_URL,
  adminSigner,
  assertAccount,
  fail,
  json,
  server,
  signPriceUpdate,
} from "@/lib/server";

/**
 * Originación con cofirma del admin. El servidor:
 *  1. valida los topes de la demo (atestación off-chain simplificada),
 *  2. firma un update de precio fresco con el oráculo,
 *  3. simula `request_loan` con el productor como fuente,
 *  4. firma la entrada de autorización del admin.
 * Devuelve la transacción para que el productor la firme con su billetera y la envíe.
 */
export async function POST(request: Request) {
  try {
    const b = await request.json().catch(() => ({}));
    const farmer = assertAccount(b.farmer);
    const principal = Number(b.principal);
    const tonnes = Number(b.tonnes);
    const days = Number(b.days);
    const hash = String(b.hash ?? "").toLowerCase();
    if (!(principal > 0 && principal <= MAX_PRINCIPAL_USDC)) throw new HttpError(400, `En la demo el crédito va de 1 a ${MAX_PRINCIPAL_USDC.toLocaleString("es-AR")} USDC.`);
    if (!Number.isInteger(tonnes) || tonnes <= 0 || tonnes > MAX_TONNES) throw new HttpError(400, `Las toneladas tienen que ser enteras, entre 1 y ${MAX_TONNES}.`);
    if (!Number.isInteger(days) || days <= 0 || days > MAX_DAYS) throw new HttpError(400, `El plazo va de 1 a ${MAX_DAYS} días.`);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, "El hash del eWarrant tiene que ser SHA-256 (64 caracteres hexadecimales).");

    const latest = await server().getLatestLedger();
    const expiry = latest.sequence + days * DAY_IN_LEDGERS;
    const price = signPriceUpdate(REFERENCE_PRICE);
    const c = new Client({ contractId: CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL, publicKey: farmer });
    const tx = await c.request_loan(
      {
        farmer,
        principal: BigInt(Math.round(principal * 1e7)),
        collateral_tonnes: BigInt(tonnes),
        expiry_ledger: expiry,
        e_warrant_hash: Buffer.from(hash, "hex"),
        price_update: price.update,
      },
      { timeoutInSeconds: 600 },
    );
    if (tx.simulation && rpc.Api.isSimulationError(tx.simulation)) throw new HttpError(400, explainError(tx.simulation.error));
    const res = tx.result as { isErr?: () => boolean; unwrapErr?: () => { message?: string } };
    if (res?.isErr?.()) throw new HttpError(400, res.unwrapErr?.().message ?? "El contrato rechazó la originación.");

    await tx.signAuthEntries(adminSigner());
    return json({ xdr: tx.toXDR(), expiry, priceUsd: price.priceUsd, publishTimeUs: price.publishTimeUs });
  } catch (e) {
    return fail(e);
  }
}
