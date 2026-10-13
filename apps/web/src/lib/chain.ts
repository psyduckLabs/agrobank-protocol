// Capa on-chain: Stellar Wallets Kit + bindings de @agrobank/client contra Soroban testnet.
// Todo se importa de forma dinámica para que nada de esto corra en el servidor.

export const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet";
export const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
export const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
export const CONTRACT_ID = process.env.NEXT_PUBLIC_AGROBANK_CONTRACT_ID || "";
export const USDC_ID = process.env.NEXT_PUBLIC_USDC_CONTRACT_ID || "";

/**
 * Token del pool. La fuente de verdad es `get_config().usdc` del contrato (se fija en
 * `initialize`); la variable de entorno es solo el valor inicial hasta leerlo on-chain.
 */
let tokenId = USDC_ID;
export const poolTokenId = () => tokenId;

const EXPLORER = `https://stellar.expert/explorer/${NETWORK}`;

/** Validez de las tx: amplia para no depender del reloj local ni de cuánto tarda la firma. */
const TX_TIMEOUT_SECS = 3600;
export const explorer = {
  tx: (hash: string) => `${EXPLORER}/tx/${hash}`,
  contract: (id: string) => `${EXPLORER}/contract/${id}`,
  account: (address: string) => `${EXPLORER}/account/${address}`,
};

export const short = (s: string, a = 4, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

/** Error de negocio devuelto por el contrato (enum Error de lib.rs) o por el SAC de USDC. */
export class ContractError extends Error {}

// enum Error de contracts/agrobank-protocol/src/lib.rs
const AGROBANK_ERRORS: Record<number, [string, string]> = {
  1: ["NotInitialized", "el contrato no fue inicializado"],
  2: ["InvalidAmount", "el monto debe ser mayor a 0"],
  3: ["InvalidRate", "tasa inválida"],
  4: ["InvalidExpiry", "el vencimiento debe ser posterior al ledger actual"],
  5: ["LoanNotFound", "el préstamo no existe"],
  6: ["LoanNotActive", "el préstamo no está activo"],
  7: ["NotBorrower", "solo el productor del préstamo puede repagarlo"],
  8: ["WarrantAlreadyPledged", "el eWarrant ya está pignorado"],
  9: ["InsufficientLiquidity", "no hay liquidez libre suficiente en el pool"],
  10: ["Undercollateralized", "el colateral no cubre el 130%"],
  11: ["NotLiquidatable", "el préstamo no está vencido ni bajo el 130%"],
  12: ["MathOverflow", "desbordamiento aritmético"],
  13: ["NoShares", "el pool no tiene participaciones"],
  14: ["StalePrice", "el precio de Pyth tiene más de 60 s"],
  15: ["InvalidPrice", "precio de Pyth inválido"],
  16: ["WrongFeed", "feed de Pyth incorrecto"],
  17: ["NothingToClaim", "todavía no hay rendimiento para cobrar"],
  18: ["AlreadyInitialized", "el contrato ya fue inicializado"],
  19: ["InsufficientShares", "el monto supera tu participación"],
  20: ["FuturePrice", "el precio de Pyth tiene fecha futura"],
};

export const TRUSTLINE_MSG =
  "Tu cuenta no tiene trustline al USDC de prueba (o todavía no existe en testnet). Agregá la trustline y pedí USDC al emisor.";

/**
 * Traduce el error de simulación de Soroban. Los mensajes del SAC (USDC) van primero:
 * #13 "trustline entry is missing" también aparece cuando la cuenta no existe.
 */
export function explainError(raw: string): string {
  const t = raw || "";
  if (/trustline entry is missing/i.test(t)) return TRUSTLINE_MSG;
  if (/balance is not sufficient|resulting balance is not within/i.test(t))
    return "Saldo de USDC insuficiente en tu billetera para esta operación.";
  if (/account entry is missing|Account not found/i.test(t))
    return "Tu cuenta no existe en testnet: fondeala con Friendbot.";
  // evento más reciente: ¿el error lo emitió el contrato de USDC o el de AgroBank?
  const ev = t.match(/contract:\s*([A-Z0-9]{56})[^\n]*?Error\(Contract, #(\d+)\)/);
  const code = Number(ev?.[2] ?? t.match(/Error\(Contract, #(\d+)\)/)?.[1] ?? NaN);
  if (ev && tokenId && ev[1] === tokenId) {
    if (code === 13) return TRUSTLINE_MSG;
    if (code === 10) return "Saldo de USDC insuficiente en tu billetera para esta operación.";
    return `Error del token USDC (#${code}).`;
  }
  if (AGROBANK_ERRORS[code]) {
    const [name, desc] = AGROBANK_ERRORS[code];
    return `${name} (#${code}): ${desc}.`;
  }
  const first = t.split("\n")[0].trim();
  return first.length > 200 ? first.slice(0, 200) + "…" : first || "Error desconocido de la red.";
}

// ── Wallet ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kitPromise: Promise<any> | null = null;

function kit() {
  if (!kitPromise) {
    kitPromise = (async () => {
      const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit/sdk");
      const { defaultModules } = await import("@creit.tech/stellar-wallets-kit/modules/utils");
      const { Networks } = await import("@creit.tech/stellar-wallets-kit/types");
      StellarWalletsKit.init({
        modules: defaultModules(),
        network: NETWORK === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
      });
      return StellarWalletsKit;
    })();
  }
  return kitPromise;
}

/** Abre el modal del kit (Freighter, xBull, Albedo, Lobstr…) y devuelve la dirección G…. */
export async function connectWallet(): Promise<string> {
  const k = await kit();
  const { address } = await k.authModal();
  return address as string;
}

export async function disconnectWallet(): Promise<void> {
  const k = await kit();
  await k.disconnect();
}

// ── Contrato ───────────────────────────────────────────────────────────

async function client(address?: string) {
  const m = await import("@agrobank/client");
  const k = address ? await kit() : null;
  return new m.Client({
    contractId: CONTRACT_ID,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: address,
    signTransaction: k
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (async (xdr: string) => {
          const r = await k.signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE, address });
          assertSigner(r?.signerAddress, address as string);
          return r;
        }) as any
      : undefined,
  });
}

/** Como unwrap, pero devuelve null en vez de lanzar. */
function unwrapSafe<T>(r: unknown): T | null {
  try {
    return r === undefined || r === null ? null : unwrap<T>(r);
  } catch {
    return null;
  }
}

/** Desenvuelve Result<T> de los bindings; un Err del contrato se vuelve ContractError. */
function unwrap<T>(r: unknown): T {
  const res = r as { isErr?: () => boolean; unwrapErr?: () => { message?: string }; unwrap?: () => T };
  if (res && typeof res.isErr === "function") {
    if (res.isErr()) throw new ContractError(res.unwrapErr?.().message ?? "Error del contrato");
    return (res.unwrap as () => T)();
  }
  return r as T;
}

export type WriteMethod =
  | "deposit_liquidity"
  | "withdraw_liquidity"
  | "claim_yield"
  | "repay_loan"
  | "liquidate_collateral";

/**
 * Simula, firma con la billetera y envía. Si la simulación devuelve un error del
 * contrato, no se pide firma. Devuelve el hash para StellarExpert.
 */
export async function invoke(address: string, method: WriteMethod, args: Record<string, unknown>) {
  const c = await client(address);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await (c as any)[method](args, { timeoutInSeconds: TX_TIMEOUT_SECS });
  // Pre-chequeo antes de pedir firma. El SDK arma el texto del Err con el doc-comment
  // de cada variante (vacío en lib.rs) y no distingue si el código vino del SAC:
  // por eso se decodifica el error crudo de la simulación.
  const simError: string | undefined = tx.simulation?.error;
  if (simError) throw new ContractError(explainError(simError));
  unwrap(tx.result);
  try {
    const sent = await tx.signAndSend();
    const hash: string = sent.sendTransactionResponse?.hash ?? "";
    const value = unwrap<unknown>(sent.result);
    return { hash, value };
  } catch (e) {
    if (e instanceof ContractError) throw e;
    const msg = (e as Error)?.message ?? String(e);
    if (/Error\(Contract|trustline|balance|account entry/i.test(msg)) throw new ContractError(explainError(msg));
    throw e;
  }
}

// ── Cuenta del usuario en testnet ──────────────────────────────────────

export interface AccountState {
  exists: boolean;
  trustline: boolean;
  usdc: bigint | null;
}

async function simulateSac(fn: string, args: unknown[] = []) {
  const m = await import("@agrobank/client");
  const server = new m.rpc.Server(RPC_URL);
  // fuente nula: la simulación no necesita una cuenta real
  const tx = new m.TransactionBuilder(new m.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"), {
    fee: m.BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new m.Contract(tokenId).call(fn, ...args))
    .setTimeout(30)
    .build();
  return { m, sim: await server.simulateTransaction(tx) };
}

export async function readAccount(address: string): Promise<AccountState> {
  const m = await import("@agrobank/client");
  const server = new m.rpc.Server(RPC_URL);
  const exists = await server.getAccount(address).then(() => true, () => false);
  if (!tokenId || !exists) return { exists, trustline: false, usdc: null };
  const { sim } = await simulateSac("balance", [new m.Address(address).toScVal()]);
  if (m.rpc.Api.isSimulationSuccess(sim) && sim.result) {
    return { exists, trustline: true, usdc: BigInt(m.scValToNative(sim.result.retval)) };
  }
  const err = String((sim as { error?: string }).error ?? "");
  return { exists, trustline: !/trustline entry is missing|#13\)/i.test(err), usdc: null };
}

/** CODE:ISSUER del USDC de prueba, leído del propio SAC (`name()`). */
export async function usdcAssetName(): Promise<string | null> {
  if (!tokenId) return null;
  const { m, sim } = await simulateSac("name");
  return m.rpc.Api.isSimulationSuccess(sim) && sim.result ? String(m.scValToNative(sim.result.retval)) : null;
}

/** Fondea la cuenta con XLM de testnet. */
export async function fundWithFriendbot(address: string): Promise<void> {
  const r = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
  if (!r.ok && r.status !== 400) throw new Error(`Friendbot respondió ${r.status}`);
}

/** changeTrust clásico al USDC de prueba, firmado con la billetera. Devuelve el hash. */
export async function addUsdcTrustline(address: string): Promise<string> {
  const m = await import("@agrobank/client");
  const k = await kit();
  const name = await usdcAssetName();
  if (!name || !name.includes(":")) throw new Error("No pude leer CODE:ISSUER del contrato de USDC.");
  const [code, issuer] = name.split(":");
  const server = new m.rpc.Server(RPC_URL);
  const account = await server.getAccount(address);
  const tx = new m.TransactionBuilder(account, { fee: m.BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(m.Operation.changeTrust({ asset: new m.Asset(code, issuer) }))
    .setTimeout(TX_TIMEOUT_SECS)
    .build();
  const { signedTxXdr, signerAddress } = await k.signTransaction(tx.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE, address });
  assertSigner(signerAddress, address);
  const sent = await server.sendTransaction(m.TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE));
  if (sent.status === "ERROR") {
    // código real de stellar-core (txBadAuth, txBadSeq, txInsufficientFee…)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = safeName(() => (sent as any).errorResult.result().switch().name);
    throw new Error(`La red rechazó la trustline (${code}). ${TX_HINTS[code] ?? ""}`.trim());
  }
  for (let i = 0; i < 20; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return sent.hash as string;
    if (r.status === "FAILED") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const op = safeName(() => (r as any).resultXdr.result().results()[0].tr().changeTrustResult().switch().name);
      throw new Error(`La trustline falló on-chain (${op}). ${TX_HINTS[op] ?? ""}`.trim());
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return sent.hash as string;
}

/** La billetera firmó con otra cuenta que la conectada (p. ej. otra cuenta activa en Freighter). */
function assertSigner(signer: string | undefined, expected: string) {
  if (signer && expected && signer !== expected) {
    throw new Error(
      `Firmaste con ${short(signer)} pero la app está conectada con ${short(expected)}. Cambiá la cuenta activa en tu billetera o desconectá y volvé a conectar.`,
    );
  }
}

function safeName(f: () => unknown): string {
  try {
    return String(f());
  } catch {
    return "sin detalle";
  }
}

const TX_HINTS: Record<string, string> = {
  txBadAuth: "La firma no corresponde a esta cuenta o red: revisá que tu billetera esté en Testnet y en la misma cuenta que conectaste.",
  txBadSeq: "Secuencia desactualizada: volvé a intentarlo.",
  txInsufficientFee: "Comisión insuficiente: volvé a intentarlo.",
  txInsufficientBalance: "No hay XLM suficiente para la comisión y la reserva.",
  txTooLate: "La transacción venció antes de llegar a la red: revisá que la hora de tu PC esté sincronizada (Windows → Configuración → Hora → Sincronizar ahora) y volvé a intentarlo.",
  changeTrustLowReserve: "Falta XLM para la reserva de la trustline (0,5 XLM).",
  changeTrustMalformed: "Activo inválido: no podés agregar trustline a un activo emitido por tu propia cuenta.",
  changeTrustNoIssuer: "El emisor del token no existe en testnet.",
};

export interface ChainLoan {
  id: number;
  farmer: string;
  principal: bigint;
  tonnes: bigint;
  start: number;
  expiry: number;
  hash: string;
  status: "Active" | "Repaid" | "Defaulted";
}

export interface ChainSnapshot {
  ledger: number;
  pool: { shares: bigint; lent: bigint; acc: bigint };
  position: { shares: bigint; rewardDebt: bigint; pending: bigint } | null;
  usdc: bigint | null;
  account: AccountState | null;
  tokenId: string;
  loans: ChainLoan[];
}

const toHex = (b: unknown): string => {
  if (b && typeof (b as { toString?: unknown }).toString === "function" && (b as Uint8Array).length !== undefined) {
    return Array.from(b as Uint8Array, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return String(b ?? "");
};

const statusOf = (s: unknown): ChainLoan["status"] => {
  const tag = typeof s === "string" ? s : (s as { tag?: string })?.tag;
  return tag === "Repaid" || tag === "Defaulted" ? tag : "Active";
};

/** Lee pool_stats, la posición del inversor, el saldo USDC y los préstamos (0..N hasta LoanNotFound). */
export async function readSnapshot(address: string | null, maxLoans = 30): Promise<ChainSnapshot> {
  const m = await import("@agrobank/client");
  const c = await client();
  const server = new m.rpc.Server(RPC_URL);

  const [latest, statsTx, cfgTx] = await Promise.all([
    server.getLatestLedger(),
    c.pool_stats(),
    c.get_config().catch(() => null),
  ]);
  const cfg = unwrapSafe<{ usdc: string }>(cfgTx?.result);
  if (cfg?.usdc) tokenId = String(cfg.usdc);
  const [shares, lent, acc] = statsTx.result as readonly [bigint, bigint, bigint];

  let position: ChainSnapshot["position"] = null;
  let usdc: bigint | null = null;
  let account: AccountState | null = null;
  if (address) {
    const [posTx, acct] = await Promise.all([c.get_investor({ investor: address }), readAccount(address).catch(() => null)]);
    const p = posTx.result as { shares: bigint; reward_debt: bigint; pending_yield: bigint };
    position = { shares: BigInt(p.shares), rewardDebt: BigInt(p.reward_debt), pending: BigInt(p.pending_yield) };
    account = acct;
    usdc = acct?.usdc ?? null;
  }

  const loans: ChainLoan[] = [];
  const batch = 10;
  for (let from = 0; from < maxLoans; from += batch) {
    const ids = Array.from({ length: batch }, (_, i) => from + i);
    const txs = await Promise.all(ids.map((id) => c.get_loan({ loan_id: BigInt(id) }).catch(() => null)));
    let done = false;
    for (let i = 0; i < txs.length; i++) {
      const r = txs[i]?.result as { isErr?: () => boolean; unwrap?: () => unknown } | undefined;
      if (!r || (typeof r.isErr === "function" && r.isErr())) {
        done = true;
        break;
      }
      const l = (typeof r.unwrap === "function" ? r.unwrap() : r) as {
        farmer_address: string;
        principal_usd: bigint;
        collateral_tonnes: bigint;
        start_ledger: number;
        expiry_ledger: number;
        e_warrant_hash: unknown;
        status: unknown;
      };
      loans.push({
        id: ids[i],
        farmer: String(l.farmer_address),
        principal: BigInt(l.principal_usd),
        tonnes: BigInt(l.collateral_tonnes),
        start: Number(l.start_ledger),
        expiry: Number(l.expiry_ledger),
        hash: toHex(l.e_warrant_hash),
        status: statusOf(l.status),
      });
    }
    if (done) break;
  }

  return {
    ledger: latest.sequence,
    pool: { shares: BigInt(shares), lent: BigInt(lent), acc: BigInt(acc) },
    position,
    usdc,
    account,
    tokenId,
    loans,
  };
}

/** Bytes vacíos para `price_update` (liquidación por vencimiento: el contrato no lee Pyth). */
export function emptyBytes(): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (globalThis as any).Buffer;
  return B ? B.alloc(0) : new Uint8Array(0);
}
