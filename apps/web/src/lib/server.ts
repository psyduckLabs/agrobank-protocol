// Operador de Testnet: claves del admin, del oráculo y del emisor del USDC de prueba.
// Solo corre en route handlers; las claves nunca llegan al navegador.
import { Asset, BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder, contract, rpc } from "@agrobank/client";

export const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
export const CONTRACT_ID = process.env.NEXT_PUBLIC_AGROBANK_CONTRACT_ID || "";
export const VERIFIER_ID = process.env.NEXT_PUBLIC_PRICE_VERIFIER_ID || "";

/** Precio de referencia de la soja (USD/t) que firma el oráculo al originar. */
export const REFERENCE_PRICE = Number(process.env.SOY_REFERENCE_PRICE || 380);
export const SOY_FEED_ID = 7;
const EXPONENT = -8;
/** Rango que acepta el oráculo para simular movimientos de mercado. */
export const PRICE_MIN = 150;
export const PRICE_MAX = 700;

/** Topes de la demo: el admin no cofirma créditos fuera de esto. */
export const MAX_PRINCIPAL_USDC = 200_000;
export const MAX_TONNES = 5_000;
export const MAX_DAYS = 365;
export const FAUCET_USDC = 50_000;

export const DAY_IN_LEDGERS = 17_280;

function secret(name: string): Keypair {
  const s = process.env[name];
  if (!s) throw new HttpError(503, `Falta configurar ${name} en el servidor.`);
  return Keypair.fromSecret(s);
}
export const adminKey = () => secret("AGROBANK_ADMIN_SECRET");
export const oracleKey = () => secret("AGROBANK_ORACLE_SECRET");
export const issuerKey = () => secret("USDC_ISSUER_SECRET");

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const server = () => new rpc.Server(RPC_URL);

export function json(data: unknown, status = 200, cache = "no-store") {
  return Response.json(data, { status, headers: { "Cache-Control": cache } });
}

export function fail(e: unknown) {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  const msg = (e as Error)?.message || String(e);
  return json({ error: msg.length > 400 ? msg.slice(0, 400) + "…" : msg }, 500);
}

export function assertAccount(address: unknown): string {
  if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
    throw new HttpError(400, "Dirección de cuenta inválida (tiene que ser una G… de Stellar).");
  }
  return address;
}

/**
 * Update de precio firmado, mismo formato que verifica `price-verifier`:
 * feed_id u32 | price i64 | exponent i32 | publish_time_us u64 (big endian) | firma ed25519.
 */
export function signPriceUpdate(priceUsd: number) {
  const price = BigInt(Math.round(priceUsd * 1e8));
  // 2 s de margen: el reloj del ledger va levemente atrás del reloj del servidor
  const publishUs = BigInt(Date.now() - 2_000) * BigInt(1000);
  const payload = Buffer.alloc(24);
  payload.writeUInt32BE(SOY_FEED_ID, 0);
  payload.writeBigInt64BE(price, 4);
  payload.writeInt32BE(EXPONENT, 12);
  payload.writeBigUInt64BE(publishUs, 16);
  const sig = oracleKey().sign(payload);
  const update = Buffer.concat([payload, sig]);
  return { hex: update.toString("hex"), update, priceUsd, publishTimeUs: publishUs.toString(), feedId: SOY_FEED_ID };
}

export function adminSigner() {
  const kp = adminKey();
  return { address: kp.publicKey(), signAuthEntry: contract.basicNodeSigner(kp, NETWORK_PASSPHRASE).signAuthEntry };
}

/** Pago clásico de USDC de prueba desde el emisor. Devuelve el hash. */
export async function sendTestUsdc(to: string, amountUsdc: number, assetCode = "USDC"): Promise<string> {
  const issuer = issuerKey();
  const s = server();
  const account = await s.getAccount(issuer.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination: to, asset: new Asset(assetCode, issuer.publicKey()), amount: amountUsdc.toFixed(7) }))
    .setTimeout(60)
    .build();
  tx.sign(issuer);
  const sent = await s.sendTransaction(tx);
  if (sent.status === "ERROR") throw new HttpError(502, "La red rechazó el pago de USDC de prueba.");
  for (let i = 0; i < 20; i++) {
    const r = await s.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return sent.hash;
    if (r.status === "FAILED") {
      throw new HttpError(400, "El pago falló on-chain: la cuenta necesita la trustline al USDC de prueba.");
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return sent.hash;
}
