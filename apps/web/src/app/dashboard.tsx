"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ACC_PRECISION,
  DAY,
  type Position,
  fromU,
  meetsRatio,
  settle,
  splitInterest,
  toU,
} from "@/lib/protocol";
import {
  CONTRACT_ID,
  type AccountState,
  type ChainSnapshot,
  ContractError,
  type WriteMethod,
  addUsdcTrustline,
  connectBurner,
  faucetUsdc,
  isBurner,
  requestLoanLive,
  signedPrice,
  connectWallet,
  fundWithFriendbot,
  usdcAssetName,
  poolTokenId,
  disconnectWallet,
  emptyBytes,
  explorer,
  invoke,
  readSnapshot,
  short,
} from "@/lib/chain";

// ── Constantes de la demo ─────────────────────────────────────────────
const P_BASE = 380;
const P_MIN = 250;
const MIN_RATIO = 1.3;
const APR_INV = 0.12;
const DEMO_LEDGER = 1_204_500;
const DEMO_WALLET = "GBX7…Q4AF";

type Status = "Active" | "Repaid" | "Defaulted";
type UiStatus = Status | "Liquidable";

interface UiLoan {
  id: number;
  farmer: string;
  principal: number;
  tn: number;
  hash: string;
  start: number;
  expiry: number;
  status: Status;
  mine: boolean;
}

interface Toast {
  k: "ok" | "err" | "info";
  m: string;
  href?: string;
}

interface TxRecord {
  fn: string;
  hash: string;
  at: string;
}

interface DefaultEvent {
  id: number;
  value: number;
  price: number;
  expired: boolean;
  tx: string;
  href?: string;
}

const fmt = (n: number, d = 0) =>
  new Intl.NumberFormat("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const usd = (n: number, d = 0) => "USDC " + fmt(n, d);
/** Copia al portapapeles; si la API no está disponible o falla, usa un textarea temporal. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

const randHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const fakeTx = () => randHex().slice(0, 10) + "…" + randHex().slice(0, 6);
const seedHash = (n: number) =>
  Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(i * 7 + n * 13 + i * i) % 16]).join("");
const loanTerm = (l: UiLoan) => Math.max(l.expiry - l.start, 0);
const repayTotal = (l: UiLoan) => l.principal + fromU(splitInterest(toU(l.principal), loanTerm(l)).total);

const SEED: UiLoan[] = [
  { id: 0, farmer: "GA4K…R7LM", principal: 50000, tn: 250, hash: seedHash(1), start: DEMO_LEDGER - DAY * 60, expiry: DEMO_LEDGER + DAY * 120, status: "Active", mine: false },
  { id: 1, farmer: "GCQ2…9XTD", principal: 45000, tn: 160, hash: seedHash(2), start: DEMO_LEDGER - DAY * 105, expiry: DEMO_LEDGER + DAY * 75, status: "Active", mine: false },
  { id: 2, farmer: "GDM6…W3EH", principal: 26500, tn: 100, hash: seedHash(3), start: DEMO_LEDGER - DAY * 10, expiry: DEMO_LEDGER + DAY * 200, status: "Active", mine: false },
];

// 'Liquidable' es un estado derivado de la UI (no existe en LoanStatus).
const loanStatus = (l: UiLoan, price: number, ledger: number): UiStatus =>
  l.status !== "Active" ? l.status : ledger > l.expiry || !meetsRatio(l.tn * price, l.principal) ? "Liquidable" : "Active";

function Badge({ status }: { status: UiStatus }) {
  const m: Record<UiStatus, [string, string]> = {
    Active: ["var(--greenbg)", "var(--green)"],
    Liquidable: ["var(--badbg)", "var(--bad)"],
    Repaid: ["var(--goldbg)", "var(--gold)"],
    Defaulted: ["var(--bad)", "var(--bg)"],
  };
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap" style={{ background: m[status][0], color: m[status][1] }}>
      {status}
    </span>
  );
}

function ExplorerLink({ href, children }: { href: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="xlink">
      {children ?? "Ver en StellarExpert"} ↗
    </a>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="mute text-sm">{label}</div>
      <div className="disp text-2xl font-bold mono mt-1">{value}</div>
      {sub && <div className="mute text-xs mt-1">{sub}</div>}
    </div>
  );
}

function Chart({ deposit, rate }: { deposit: number; rate: number }) {
  const pts = Array.from({ length: 13 }, (_, m) => (deposit * rate * m) / 12);
  const max = Math.max(pts[12], 1);
  const W = 560, H = 190, p = 28;
  const xy = (v: number, i: number): [number, number] => [p + (i * (W - 2 * p)) / 12, H - p - (v / max) * (H - 2 * p)];
  const line = pts.map((v, i) => xy(v, i).join(",")).join(" ");
  const area = `${p},${H - p} ${line} ${W - p},${H - p}`;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 420, width: "100%" }} role="img" aria-label="Ganancias proyectadas a 12 meses">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={p} x2={W - p} y1={H - p - f * (H - 2 * p)} y2={H - p - f * (H - 2 * p)} stroke="var(--line)" />
            <text x={p} y={H - p - f * (H - 2 * p) - 4} fontSize="10" fill="var(--mute)">{fmt(max * f)}</text>
          </g>
        ))}
        <polygon points={area} fill="var(--green)" opacity=".15" />
        <polyline points={line} fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinejoin="round" />
        {pts.map((v, i) =>
          i % 3 === 0 ? (
            <g key={i}>
              <circle cx={xy(v, i)[0]} cy={xy(v, i)[1]} r="3.5" fill="var(--green)" />
              <text x={xy(v, i)[0]} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--mute)">mes {i}</text>
            </g>
          ) : null,
        )}
      </svg>
    </div>
  );
}

// ── Vista de datos común a demo y testnet ─────────────────────────────
interface View {
  live: boolean;
  ledger: number;
  pool: { shares: number; lent: number };
  pos: number;
  pending: number;
  wallet: number | null;
  walletNote?: string;
  loans: UiLoan[];
  warrants: Set<string>;
}

interface Actions {
  busy: boolean;
  fail: (m: string) => void;
  deposit: (a: number) => void;
  withdraw: (a: number) => void;
  claim: () => void;
  borrow: (b: { tn: number; principal: number; hash: string; days: number }) => void;
  repay: (id: number) => void;
}

function Investor({ v, a }: { v: View; a: Actions }) {
  const [amt, setAmt] = useState("1000");
  const [wAmt, setWAmt] = useState("1000");
  const d = parseFloat(amt) || 0;
  const w = parseFloat(wAmt) || 0;
  const util = v.pool.shares > 0 ? v.pool.lent / v.pool.shares : 0;
  const free = v.pool.shares - v.pool.lent;
  const depErr = !(d > 0) ? "InvalidAmount (#2): el monto debe ser > 0." : v.wallet !== null && d > v.wallet ? "El monto supera tu saldo de USDC." : null;
  // mismos chequeos y orden que withdraw_liquidity()
  const wErr = !(w > 0)
    ? "InvalidAmount (#2): el monto debe ser > 0."
    : w > v.pos
      ? "InsufficientShares (#19): supera tu participación."
      : w > free
        ? `InsufficientLiquidity (#9): solo hay ${usd(free, 2)} sin prestar.`
        : null;
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="grid gap-4 lg:col-span-5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pool de staking" value={usd(v.pool.shares)} sub="TotalShares" />
        <Stat label="Prestado a productores" value={usd(v.pool.lent)} sub={`Utilización ${fmt(util * 100, 1)}%`} />
        <Stat label="Rendimiento efectivo" value={fmt(APR_INV * util * 100, 2) + "%"} sub={`12% TNA × utilización ${fmt(util * 100, 1)}%`} />
        <Stat label="Tu posición" value={usd(v.pos, v.live ? 2 : 0)} sub={`Cobrable: ${usd(v.pending, 2)}`} />
      </div>
      <div className="card p-5 lg:col-span-2">
        <h2 className="text-xl font-semibold">Depositar liquidez</h2>
        <p className="mute text-sm mt-1">
          Saldo en billetera: <b className="mono">{v.wallet === null ? v.walletNote ?? "—" : usd(v.wallet, 2)}</b>
        </p>
        <label className="block mt-4 text-sm font-medium" htmlFor="dep">Monto a depositar</label>
        <input id="dep" className="inp mono mt-1" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
        <div className="flex gap-2 mt-2">
          {[500, 1000, 5000].map((x) => (
            <button key={x} className="btn btn2 text-sm" style={{ padding: ".3rem .7rem" }} onClick={() => setAmt(String(x))}>{fmt(x)}</button>
          ))}
        </div>
        {depErr && d !== 0 && <p className="text-sm mt-3" style={{ color: "var(--bad)" }}>{depErr}</p>}
        <div className="mt-4 text-sm mute">
          Ganarías ≈ <b style={{ color: "var(--green)" }} className="mono">{usd(d * APR_INV * util, 2)}</b> en 12 meses.
        </div>
        <button className="btn w-full mt-4" disabled={!!depErr || a.busy} onClick={() => a.deposit(d)}>
          {a.busy ? "Procesando…" : "Depositar USDC"}
        </button>
        <button
          className="btn btn2 w-full mt-2"
          disabled={a.busy}
          onClick={() => (v.pending > 0 ? a.claim() : a.fail("NothingToClaim (#17): todavía no hay intereses repagados para cobrar."))}
        >
          Cobrar rendimiento ({usd(v.pending, 2)})
        </button>
        <p className="mute text-xs mt-3">
          Llama a <code>deposit_liquidity(investor, amount)</code>. El rendimiento se acredita recién cuando un productor ejecuta{" "}
          <code>repay_loan</code> (acumulador <code>AccYieldPerShare</code>).
        </p>
        <h3 className="text-lg font-semibold mt-6">Retirar capital</h3>
        <p className="mute text-sm mt-1">
          Solo capital no prestado: <b className="mono">{usd(free, 2)}</b> libres en el pool.
        </p>
        <label className="block mt-3 text-sm font-medium" htmlFor="wd">Monto a retirar</label>
        <input id="wd" className="inp mono mt-1" inputMode="decimal" value={wAmt} onChange={(e) => setWAmt(e.target.value)} />
        {wErr && w !== 0 && <p className="text-sm mt-2" style={{ color: "var(--bad)" }}>{wErr}</p>}
        <button className="btn btn2 w-full mt-3" disabled={!!wErr || a.busy} onClick={() => a.withdraw(w)}>Retirar USDC</button>
      </div>
      <div className="card p-5 lg:col-span-3">
        <h2 className="text-xl font-semibold">Ganancias esperadas (proyección)</h2>
        <Chart deposit={v.pos} rate={APR_INV * util} />
        <p className="mute text-sm">
          A 12 meses: <b className="mono" style={{ color: "var(--green)" }}>{usd(v.pos * APR_INV * util, 2)}</b> sobre {usd(v.pos)}, si la
          utilización se mantiene en {fmt(util * 100, 1)}%. Es una estimación: on-chain el rendimiento se devenga en saltos, en cada repago.
        </p>
      </div>
    </div>
  );
}

function Producer({ v, a, price }: { v: View; a: Actions; price: number }) {
  const [tn, setTn] = useState("500");
  const [pr, setPr] = useState("50000");
  const [hash, setHash] = useState("");
  const [days, setDays] = useState("180");
  const t = parseFloat(tn) || 0;
  const p = parseFloat(pr) || 0;
  const value = t * price;
  const ratio = p > 0 ? value / p : 0;
  const ltv = value > 0 ? p / value : 0;
  const maxLoan = value / MIN_RATIO;
  const free = v.pool.shares - v.pool.lent;
  const hashOk = /^[0-9a-fA-F]{64}$/.test(hash.trim());
  const ratioOk = meetsRatio(value, p);
  const h = hash.trim().toLowerCase();
  const tInt = Number.isInteger(t) && t > 0;
  const dOk = /^\d+$/.test(days) && parseInt(days) > 0;
  // mismo orden en que el contrato los lanza
  const errs = [
    !(t > 0 && p > 0) && "InvalidAmount (#2): principal y toneladas deben ser > 0.",
    t > 0 && !tInt && "collateral_tonnes es i128: ingresá toneladas enteras.",
    !dOk && "InvalidExpiry (#4): el plazo debe ser ≥ 1 día (expiry_ledger > ledger actual).",
    !hashOk && "e_warrant_hash es BytesN<32>: 64 caracteres hexadecimales (SHA-256).",
    hashOk && v.warrants.has(h) && "WarrantAlreadyPledged (#8): este eWarrant ya está pignorado.",
    p > 0 && p > free && `InsufficientLiquidity (#9): el pool tiene ${usd(free)} disponibles.`,
    t > 0 && p > 0 && !ratioOk && `Undercollateralized (#10): cobertura ${fmt(ratio * 100, 1)}%, el mínimo es 130%.`,
  ].filter((e): e is string => typeof e === "string");
  const ok = errs.length === 0;
  const term = dOk ? parseInt(days) * DAY : 0; // expiry_ledger − start_ledger
  const sp = p > 0 && term > 0 ? splitInterest(toU(p), term) : null;
  const interest = sp ? fromU(sp.total) : 0;
  const inv = sp ? fromU(sp.inv) : 0;
  const spread = sp ? fromU(sp.spread) : 0;
  const effPct = p > 0 ? (interest / p) * 100 : 0;
  const gaugePct = Math.min(ltv, 1) * 100;
  const limitPct = (1 / MIN_RATIO) * 100;
  const level = ltv === 0 ? "var(--mute)" : ratioOk ? "var(--green)" : "var(--bad)";
  const mine = v.loans.filter((l) => l.mine);
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="card p-5 lg:col-span-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-xl font-semibold">Solicitar crédito contra eWarrant</h2>
          <span className="text-sm px-3 py-1 rounded-full flex items-center gap-2" style={{ background: "var(--goldbg)", color: "var(--gold)" }}>
            <span className="dot" style={{ width: 8, height: 8, borderRadius: 9, background: "var(--gold)" }} />
            Pyth · Soja USD {price}/t
          </span>
        </div>
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="text-sm font-medium" htmlFor="tn">Toneladas de soja</label>
            <input id="tn" className="inp mono mt-1" inputMode="decimal" value={tn} onChange={(e) => setTn(e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="pr">Monto a solicitar (USDC)</label>
            <input id="pr" className="inp mono mt-1" inputMode="decimal" value={pr} onChange={(e) => setPr(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="hs">Hash SHA-256 del eWarrant [Decreto 640/2024]</label>
            <div className="flex gap-2 mt-1">
              <input id="hs" className="inp mono" style={{ fontSize: ".8rem" }} placeholder="64 caracteres hexadecimales" value={hash} onChange={(e) => setHash(e.target.value)} />
              <button className="btn btn2 text-sm" style={{ whiteSpace: "nowrap" }} onClick={() => setHash(randHex())}>Hash de prueba</button>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dy">Plazo hasta vencimiento (días)</label>
            <input id="dy" className="inp mono mt-1" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            <p className="mute text-xs mt-1">Se convierte en <code>expiry_ledger</code> (≈ 17.280 ledgers/día).</p>
          </div>
        </div>
        <div className="mt-6">
          <div className="flex justify-between text-sm">
            <span className="font-medium">LTV (préstamo / valor del colateral)</span>
            <b className="mono" style={{ color: level }}>{fmt(ltv * 100, 1)}% · máx. {fmt(limitPct, 1)}%</b>
          </div>
          <div style={{ position: "relative", height: 22, marginTop: 8, borderRadius: 8, background: "var(--bg)", border: "1px solid var(--line)", overflow: "hidden" }}>
            <div style={{ width: gaugePct + "%", height: "100%", background: level, transition: "width .3s" }} />
            <div style={{ position: "absolute", left: limitPct + "%", top: 0, bottom: 0, width: 2, background: "var(--ink)" }} />
          </div>
          <div className="flex justify-between mute text-xs mt-1"><span>0%</span><span>Límite 130% de cobertura</span><span>100%</span></div>
        </div>
        {errs.length > 0 && (
          <ul className="mt-4 text-sm grid gap-1" style={{ color: "var(--bad)" }}>
            {errs.map((e) => <li key={e}>• {e}</li>)}
          </ul>
        )}
        <button className="btn w-full mt-5" disabled={!ok || a.busy} onClick={() => a.borrow({ tn: t, principal: p, hash: h, days: parseInt(days) })}>
          {a.busy ? "Procesando…" : "Solicitar crédito"}
        </button>
        <p className="mute text-xs mt-2">
          {v.live
            ? "En testnet, el servidor de AgroBank valida el pedido, firma un precio fresco del oráculo (USD 380/t de referencia) y cofirma como admin. Vos firmás la transacción y el contrato verifica la firma del precio, el 130% y el hash on-chain."
            : "Llama a request_loan (requiere firma del productor y del admin; la demo simula ambas)."}
        </p>
      </div>
      <div className="grid gap-4 lg:col-span-2 content-start">
        <div className="card p-5">
          <h3 className="text-lg font-semibold">Valuación del colateral</h3>
          <dl className="grid grid-cols-2 gap-y-2 text-sm mt-3 mono">
            <dt className="mute">Precio Pyth</dt><dd className="text-right">USD {price}/t</dd>
            <dt className="mute">Toneladas</dt><dd className="text-right">{fmt(t)} t</dd>
            <dt className="mute">Valor del colateral</dt><dd className="text-right font-bold">{usd(value)}</dd>
            <dt className="mute">Cobertura</dt><dd className="text-right font-bold" style={{ color: level }}>{fmt(ratio * 100, 1)}%</dd>
            <dt className="mute">Máximo prestable</dt><dd className="text-right">{usd(maxLoan)}</dd>
            <dt className="mute">Liquidez del pool</dt><dd className="text-right">{usd(free)}</dd>
          </dl>
        </div>
        <div className="card p-5">
          <h3 className="text-lg font-semibold">Repago: split atómico</h3>
          <p className="mute text-sm mt-1">
            Al llamar <code>repay_loan</code>, en una transacción. Interés prorrateado a {fmt(term)} ledgers ({dOk ? parseInt(days) : 0} días × 17.280) sobre 6.307.200 por año:
          </p>
          <dl className="grid grid-cols-2 gap-y-2 text-sm mt-3 mono">
            <dt className="mute">Capital + 12% TNA → pool</dt><dd className="text-right">{usd(p + inv, 2)}</dd>
            <dt className="mute">Spread 6% TNA → tesorería</dt><dd className="text-right">{usd(spread, 2)}</dd>
            <dt className="mute font-semibold">Total a pagar (18% TNA)</dt><dd className="text-right font-bold">{usd(p + interest, 2)}</dd>
            <dt className="mute">Tasa efectiva del plazo</dt><dd className="text-right">{fmt(effPct, 3)}%</dd>
          </dl>
          <p className="mute text-xs mt-2">El interés se fija sobre el plazo pactado (<code>expiry_ledger − start_ledger</code>): repagar antes no lo reduce.</p>
        </div>
        {mine.length > 0 && (
          <div className="card p-5">
            <h3 className="text-lg font-semibold">Tus créditos</h3>
            <ul className="mt-2 grid gap-3">
              {mine.map((l) => (
                <li key={l.id} className="text-sm">
                  <div className="flex justify-between"><b>Préstamo #{l.id}</b><Badge status={loanStatus(l, price, v.ledger)} /></div>
                  <div className="mute mono">{usd(l.principal)} · {fmt(l.tn)} t · {l.hash.slice(0, 10)}…</div>
                  {l.status === "Active" && (
                    <button className="btn btn2 text-sm mt-2" disabled={a.busy} onClick={() => a.repay(l.id)}>
                      Repagar {usd(repayTotal(l), 2)}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Keeper({
  v,
  price,
  setPrice,
  busy,
  liq,
  events,
  liquidate,
}: {
  v: View;
  price: number;
  setPrice: (p: number) => void;
  busy: boolean;
  liq: { id: number; stage: number; payload: string } | null;
  events: DefaultEvent[];
  liquidate: (id: number) => void;
}) {
  const risky = v.loans.filter((l) => loanStatus(l, price, v.ledger) === "Liquidable").length;
  const drop = (price / P_BASE - 1) * 100;
  const steps = v.live
    ? ["Pedir precio firmado al oráculo", "Firmar liquidate_collateral", "Verificar firma on-chain y confirmar"]
    : ["Obtener payload firmado de Pyth (leEcdsa)", "Simular liquidate_collateral", "Firmar y confirmar en red"];
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Precio Pyth (soja)" value={`USD ${price}/t`} sub={drop === 0 ? "Sin variación" : `${fmt(drop, 1)}% vs. USD ${P_BASE}`} />
        <Stat label="Créditos en riesgo" value={`${risky} de ${v.loans.filter((l) => l.status === "Active").length}`} sub="Bajo 130% de cobertura o vencidos" />
        <Stat label="Ledger actual" value={fmt(v.ledger)} sub={v.live ? "Soroban testnet" : "Referencia para expiry_ledger"} />
      </div>
      <div className="card p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h2 className="text-xl font-semibold">Simular caída del precio de la soja</h2>
          <div className="flex gap-2">
            <button className="btn btn2 text-sm" disabled={busy} onClick={() => setPrice(P_BASE)}>Restablecer USD {P_BASE}</button>
            <button className="btn text-sm" style={{ background: "var(--bad)" }} disabled={busy} onClick={() => setPrice(P_MIN)}>Caer a USD {P_MIN}</button>
          </div>
        </div>
        <div className="flex items-center gap-4 mt-4">
          <span className="mute text-sm mono">USD {P_MIN}</span>
          <input aria-label="Precio de la soja en USD por tonelada" className="flex-1" type="range" min={P_MIN} max={P_BASE} step="1" value={price} disabled={busy} onChange={(e) => setPrice(+e.target.value)} />
          <span className="mute text-sm mono">USD {P_BASE}</span>
          <b className="disp text-2xl mono" style={{ color: drop < 0 ? "var(--bad)" : "var(--ink)" }}>{price}</b>
        </div>
        <p className="mute text-xs mt-2">
          {v.live
            ? "Al liquidar, el oráculo de Testnet firma este precio y el contrato verificador valida la firma ed25519 on-chain antes de usarlo. Un crédito vencido se liquida sin consultar el oráculo."
            : "Reemplaza el precio verificado de Pyth que recibiría liquidate_collateral(loan_id, price_update)."}
        </p>
      </div>
      {liq && (
        <div className="card p-5" role="status">
          <h3 className="text-lg font-semibold">Liquidando préstamo #{liq.id}</h3>
          <ol className="grid gap-2 mt-3 text-sm">
            {steps.map((t, i) => (
              <li key={t} className="flex items-center gap-3" style={{ color: i <= liq.stage ? "var(--ink)" : "var(--mute)" }}>
                <span className={i === liq.stage ? "dot" : ""} style={{ width: 22, height: 22, borderRadius: 99, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, background: i < liq.stage ? "var(--green)" : i === liq.stage ? "var(--gold)" : "var(--line)", color: "var(--bg)" }}>
                  {i < liq.stage ? "✓" : i + 1}
                </span>
                <span className="font-medium">{t}</span>
                {!v.live && i === 0 && liq.stage >= 1 && (
                  <code className="mono text-xs mute" style={{ wordBreak: "break-all" }}>price_update = 0x{liq.payload.slice(0, 40)}…</code>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="card p-5">
        <h2 className="text-xl font-semibold">Créditos originados</h2>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-sm mt-3" style={{ minWidth: 820, borderCollapse: "collapse" }}>
            <thead>
              <tr className="mute text-left">
                {["ID", "Productor", "Hash eWarrant", "Colateral", "Liquida bajo", "Expira (ledger)", "Estado", ""].map((h) => (
                  <th key={h} className="py-2 pr-3 font-medium" style={{ borderBottom: "1px solid var(--line)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {v.loans.length === 0 && (
                <tr><td colSpan={8} className="py-4 mute">Todavía no hay préstamos originados en este contrato.</td></tr>
              )}
              {v.loans.map((l) => {
                const st = loanStatus(l, price, v.ledger);
                const ratio = l.principal > 0 ? (l.tn * price) / l.principal : 0;
                const bad = st === "Liquidable";
                const expired = v.ledger > l.expiry;
                const canRun = bad;
                return (
                  <tr key={l.id} style={{ background: bad ? "var(--badbg)" : "transparent", borderBottom: "1px solid var(--line)" }}>
                    <td className="py-3 pr-3 px-2 font-semibold">#{l.id}</td>
                    <td className="pr-3 mono">{l.farmer}{l.mine ? " (vos)" : ""}</td>
                    <td className="pr-3 mono" title={l.hash}>{l.hash.slice(0, 8)}…{l.hash.slice(-6)}</td>
                    <td className="pr-3 mono">
                      <b style={{ color: bad ? "var(--bad)" : l.status === "Active" ? "var(--green)" : "var(--mute)" }}>{fmt(ratio * 100, 1)}%</b>
                      <div className="mute text-xs">{fmt(l.tn)} t · {usd(l.principal)}</div>
                    </td>
                    <td className="pr-3 mono">USD {l.tn > 0 ? fmt((l.principal * MIN_RATIO) / l.tn, 1) : "—"}</td>
                    <td className="pr-3 mono">{fmt(l.expiry)}</td>
                    <td className="pr-3"><Badge status={st} /></td>
                    <td className="pr-2 text-right">
                      <button
                        className="btn text-sm"
                        style={{ background: "var(--bad)", whiteSpace: "nowrap" }}
                        disabled={!canRun || busy}
                        title={bad ? (expired ? "Vencido: el contrato no consulta el oráculo" : "Bajo 130%: se envía un precio firmado por el oráculo de Testnet") : undefined}
                        onClick={() => liquidate(l.id)}
                      >
                        {v.live ? "Liquidar on-chain" : "Ejecutar Liquidación de Pyth"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mute text-xs mt-3">La liquidación es permisionless: cualquier keeper puede llamarla. Si el crédito no está bajo 130% ni venció, el contrato responde <code>NotLiquidatable</code>.</p>
      </div>
      {events.map((e) => (
        <div key={`${e.id}-${e.tx}`} className="card p-5" style={{ borderColor: "var(--bad)" }}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-lg font-semibold">Evento on-chain: LoanDefaulted</h3>
            {e.href ? <ExplorerLink href={e.href} /> : <span className="mono text-xs mute">tx {e.tx} (simulada)</span>}
          </div>
          <pre className="mono text-xs mt-3 p-3 rounded-lg" style={{ background: "var(--bg)", overflowX: "auto", margin: 0 }}>
            {`{ loan_id: ${e.id}, expired: ${String(e.expired)}, collateral_value: ${fmt(e.value * 1e7)} ${e.expired ? "/* vencido: el contrato no consulta Pyth */" : `/* USDC 7 dec. · USD ${fmt(e.value)} a USD ${e.price}/t */`} }`}
          </pre>
          <p className="text-sm mt-3">
            <b style={{ color: "var(--bad)" }}>Estado final: Defaulted.</b> Se libera la ejecución física y legal off-chain del grano en el acopio
            argentino bajo el Decreto 640/2024. El contrato solo cambia el estado; la ejecución del eWarrant ocurre fuera de la cadena.
          </p>
        </div>
      ))}
    </div>
  );
}

function AccountSetup({
  address,
  acct,
  assetName,
  busy,
  onFund,
  onTrust,
  onRefresh,
  onCopy,
  onFaucet,
}: {
  address: string;
  acct: AccountState;
  assetName: string | null;
  busy: boolean;
  onFund: () => void;
  onTrust: () => void;
  onRefresh: () => void;
  onCopy: (text: string, what: string) => void;
  onFaucet: () => void;
}) {
  const hasUsdc = acct.usdc !== null && acct.usdc > BigInt(0);
  if (acct.exists && acct.trustline && hasUsdc) return null;
  const cmd = `stellar tx new payment --source usdc-issuer --destination ${address} --asset ${assetName ?? "USDC:<ISSUER>"} --amount 200000000000 --rpc-url https://soroban-testnet.stellar.org --network-passphrase "Test SDF Network ; September 2015"`;
  const steps: { done: boolean; title: string; body: React.ReactNode }[] = [
    {
      done: acct.exists,
      title: "Cuenta activa en testnet",
      body: acct.exists ? null : (
        <button className="btn text-sm mt-2" disabled={busy} onClick={onFund}>Fondear con Friendbot (XLM de prueba)</button>
      ),
    },
    {
      done: acct.exists && acct.trustline,
      title: `Trustline al ${assetName?.split(":")[0] ?? "USDC"} de prueba`,
      body:
        acct.exists && !acct.trustline ? (
          <div className="mt-2 grid gap-2">
            <div><button className="btn text-sm" disabled={busy} onClick={onTrust}>Agregar trustline USDC</button></div>
            {assetName && assetName.includes(":") && (
              <div className="mute text-xs grid gap-1">
                <span>
                  O agregalo a mano en tu billetera (Freighter → <b>Add token</b> → manual) con estos datos:
                </span>
                <span className="mono" style={{ wordBreak: "break-all" }}>
                  Código <b>{assetName.split(":")[0]}</b> · Emisor <b>{assetName.split(":")[1]}</b>
                </span>
                <div>
                  <button className="btn btn2 text-sm" style={{ padding: ".3rem .7rem" }} onClick={() => onCopy(assetName.split(":")[1] ?? "", "Emisor")}>Copiar emisor</button>{" "}
                  <button className="btn btn2 text-sm" style={{ padding: ".3rem .7rem" }} disabled={busy} onClick={onRefresh}>{busy ? "Actualizando…" : "Ya la agregué, actualizar"}</button>
                </div>
              </div>
            )}
          </div>
        ) : null,
    },
    {
      done: hasUsdc,
      title: "Saldo de USDC para depositar o repagar",
      body:
        acct.trustline && !hasUsdc ? (
          <div className="mt-2 grid gap-2">
            <div><button className="btn text-sm" disabled={busy} onClick={onFaucet}>Recibir 50.000 USDC de prueba</button></div>
            <details className="mute text-xs">
              <summary>O pedilo desde la CLI</summary>
              <pre className="mono text-xs p-3 rounded-lg mt-2" style={{ background: "var(--bg)", overflowX: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{cmd}</pre>
              <button className="btn btn2 text-sm mt-2" onClick={() => onCopy(cmd, "Comando")}>Copiar comando</button>
            </details>
          </div>
        ) : null,
    },
  ];
  return (
    <div className="card p-5 mb-4" style={{ borderColor: "var(--gold)" }}>
      <h2 className="text-lg font-semibold">Prepará tu cuenta de testnet</h2>
      <p className="mute text-sm mt-1">
        Tu billetera <ExplorerLink href={explorer.account(address)}>{short(address)}</ExplorerLink> todavía no puede operar con el
        token del pool: su contrato (SAC) rechaza la transferencia con <code>Error(Contract, #13)</code>.
      </p>
      <p className="text-sm mt-2">
        El pool acepta solo <b className="mono">{assetName ? `${assetName.split(":")[0]} · emisor ${short(assetName.split(":")[1] ?? "", 4, 4)}` : "el token configurado en initialize"}</b>{" "}
        (<ExplorerLink href={explorer.contract(poolTokenId())}>{short(poolTokenId(), 6, 6)}</ExplorerLink>). Si en tu billetera ves otro
        USDC con saldo, es un activo distinto: mismo código, otro emisor.
      </p>
      <ol className="grid gap-3 mt-3 text-sm">
        {steps.map((st, i) => (
          <li key={st.title} className="flex gap-3">
            <span style={{ width: 22, height: 22, flex: "none", borderRadius: 99, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700, background: st.done ? "var(--green)" : "var(--line)", color: "var(--bg)" }}>
              {st.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0">
              <div className="font-medium">{st.title}</div>
              {st.body}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function Dashboard() {
  const [tab, setTab] = useState<"inv" | "prod" | "keep">("inv");
  const [price, setPrice] = useState(P_BASE);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [liq, setLiq] = useState<{ id: number; stage: number; payload: string } | null>(null);
  const [events, setEvents] = useState<DefaultEvent[]>([]);
  const [txs, setTxs] = useState<TxRecord[]>([]);

  // ── Estado demo ──
  const [dWallet, setDWallet] = useState(25000);
  const [dPool, setDPool] = useState({ shares: 184200, lent: 121500 });
  const [dInv, setDInv] = useState<Position>({ shares: toU(5000), rewardDebt: BigInt(0), pending: BigInt(0) });
  const [dAcc, setDAcc] = useState(BigInt(0));
  const [dLoans, setDLoans] = useState<UiLoan[]>(SEED);
  const [dWarrants, setDWarrants] = useState<Set<string>>(() => new Set(SEED.map((l) => l.hash)));

  // ── Estado testnet ──
  const [address, setAddress] = useState<string | null>(null);
  const [snap, setSnap] = useState<ChainSnapshot | null>(null);
  const [assetName, setAssetName] = useState<string | null>(null);
  const live = address !== null;

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const refresh = useCallback(async (addr: string | null) => {
    try {
      setSnap(await readSnapshot(addr));
    } catch (e) {
      setToast({ k: "err", m: `No pude leer el contrato en testnet: ${(e as Error).message}` });
    }
  }, []);

  // ── Vista unificada ──
  let view: View;
  if (live && snap) {
    const pos = snap.position ? settle(snap.position, snap.pool.acc) : null;
    const loans: UiLoan[] = snap.loans.map((l) => ({
      id: l.id,
      farmer: short(l.farmer),
      principal: fromU(l.principal),
      tn: Number(l.tonnes),
      hash: l.hash,
      start: l.start,
      expiry: l.expiry,
      status: l.status,
      mine: l.farmer === address,
    }));
    view = {
      live: true,
      ledger: snap.ledger,
      pool: { shares: fromU(snap.pool.shares), lent: fromU(snap.pool.lent) },
      pos: pos ? fromU(pos.shares) : 0,
      pending: pos ? fromU(pos.pending) : 0,
      wallet: snap.usdc === null ? null : fromU(snap.usdc),
      walletNote: snap.account && !snap.account.exists ? "cuenta sin fondear" : snap.account && !snap.account.trustline ? "sin trustline USDC" : "—",
      loans,
      warrants: new Set(snap.loans.filter((l) => l.status !== "Repaid").map((l) => l.hash)),
    };
  } else {
    view = {
      live: false,
      ledger: DEMO_LEDGER,
      pool: dPool,
      pos: fromU(dInv.shares),
      pending: fromU(settle(dInv, dAcc).pending),
      wallet: dWallet,
      loans: dLoans,
      warrants: dWarrants,
    };
  }

  // ── Ejecución: testnet (firma real + StellarExpert) o demo (simulada) ──
  const runLive = async (fn: WriteMethod, args: Record<string, unknown>) => {
    if (!address) return null;
    setBusy(true);
    setToast({ k: "info", m: `Simulando ${fn}() y esperando la firma en tu billetera…` });
    try {
      const { hash } = await invoke(address, fn, args);
      setTxs((t) => [{ fn, hash, at: new Date().toLocaleTimeString("es-AR") }, ...t].slice(0, 8));
      setToast({ k: "ok", m: `${fn}() confirmada · tx ${short(hash, 8, 6)}`, href: explorer.tx(hash) });
      await refresh(address);
      return hash;
    } catch (e) {
      const msg = e instanceof ContractError ? e.message : (e as Error)?.message || String(e);
      setToast({ k: "err", m: msg.length > 220 ? msg.slice(0, 220) + "…" : msg });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const runDemo = (fn: string, action: () => void) => {
    setBusy(true);
    setToast({ k: "info", m: `Simulando ${fn}()…` });
    setTimeout(() => {
      action();
      setBusy(false);
      setToast({ k: "ok", m: `${fn}() simulada · tx ${fakeTx()} (conectá tu billetera para operar en testnet)` });
    }, 1200);
  };

  const actions: Actions = {
    busy,
    fail: (m) => setToast({ k: "err", m }),
    deposit: (amt) => {
      if (live) return void runLive("deposit_liquidity", { investor: address, amount: toU(amt) });
      runDemo("deposit_liquidity", () => {
        const aU = toU(amt);
        const p = settle(dInv, dAcc);
        const shares = p.shares + aU;
        setDInv({ ...p, shares, rewardDebt: (shares * dAcc) / ACC_PRECISION });
        setDWallet((w) => w - amt);
        setDPool((pl) => ({ ...pl, shares: pl.shares + amt }));
      });
    },
    withdraw: (amt) => {
      if (live) return void runLive("withdraw_liquidity", { investor: address, amount: toU(amt) });
      runDemo("withdraw_liquidity", () => {
        const aU = toU(amt);
        const p = settle(dInv, dAcc);
        const shares = p.shares - aU;
        setDInv({ ...p, shares, rewardDebt: (shares * dAcc) / ACC_PRECISION });
        setDWallet((w) => w + amt);
        setDPool((pl) => ({ ...pl, shares: pl.shares - amt }));
      });
    },
    claim: () => {
      if (live) return void runLive("claim_yield", { investor: address });
      runDemo("claim_yield", () => {
        const p = settle(dInv, dAcc);
        setDWallet((w) => w + fromU(p.pending));
        setDInv({ ...p, pending: BigInt(0) });
      });
    },
    borrow: ({ tn, principal, hash, days }) => {
      if (live && address) {
        setBusy(true);
        setToast({ k: "info", m: "El admin valida y cofirma; después firmá request_loan en tu billetera…" });
        requestLoanLive(address, { principal, tonnes: tn, days, hash })
          .then(async (r) => {
            setTxs((t) => [{ fn: "request_loan", hash: r.hash, at: new Date().toLocaleTimeString("es-AR") }, ...t].slice(0, 8));
            setToast({ k: "ok", m: `request_loan() confirmada · préstamo #${r.loanId ?? "?"} a USD ${r.priceUsd}/t · tx ${short(r.hash, 8, 6)}`, href: explorer.tx(r.hash) });
            await refresh(address);
          })
          .catch((e) => setToast({ k: "err", m: (e as Error).message }))
          .finally(() => setBusy(false));
        return;
      }
      runDemo("request_loan", () => {
        setDPool((p) => ({ ...p, lent: p.lent + principal }));
        setDWallet((w) => w + principal);
        setDWarrants((w) => new Set(w).add(hash));
        setDLoans((l) => [...l, { id: l.length, farmer: DEMO_WALLET, principal, tn, hash, start: DEMO_LEDGER, expiry: DEMO_LEDGER + days * DAY, status: "Active", mine: true }]);
      });
    },
    // repay_loan(): split atómico + AccYieldPerShare += interés_inversores × 1e12 / total_shares
    repay: (id) => {
      if (live) return void runLive("repay_loan", { farmer: address, loan_id: BigInt(id) });
      const l = dLoans.find((x) => x.id === id);
      if (!l) return;
      runDemo("repay_loan", () => {
        const pU = toU(l.principal);
        const { total, inv } = splitInterest(pU, loanTerm(l));
        setDAcc((a) => a + (inv * ACC_PRECISION) / toU(dPool.shares));
        setDLoans((ls) => ls.map((x) => (x.id === id ? { ...x, status: "Repaid" } : x)));
        setDPool((p) => ({ shares: p.shares, lent: p.lent - l.principal }));
        setDWallet((w) => w - fromU(pU + total));
        setDWarrants((w) => {
          const n = new Set(w);
          n.delete(l.hash);
          return n;
        });
      });
    },
  };

  const liquidate = async (id: number) => {
    const l = view.loans.find((x) => x.id === id);
    if (!l) return;
    const expired = view.ledger > l.expiry;
    const value = expired ? 0 : Math.round(l.tn * price);
    if (live) {
      let update: Uint8Array = emptyBytes();
      let payload = "";
      if (!expired) {
        try {
          const sp = await signedPrice(price);
          update = sp.bytes;
          payload = sp.hex;
        } catch (e) {
          setToast({ k: "err", m: (e as Error).message });
          return;
        }
      }
      setLiq({ id, stage: 1, payload });
      const hash = await runLive("liquidate_collateral", { loan_id: BigInt(id), price_update: update });
      setLiq(null);
      if (hash) setEvents((e) => [{ id, value, price, expired, tx: hash, href: explorer.tx(hash) }, ...e]);
      return;
    }
    const payload = randHex();
    setBusy(true);
    setToast(null);
    setLiq({ id, stage: 0, payload });
    setTimeout(() => setLiq({ id, stage: 1, payload }), 1300);
    setTimeout(() => setLiq({ id, stage: 2, payload }), 2800);
    setTimeout(() => {
      setDLoans((ls) => ls.map((x) => (x.id === id ? { ...x, status: "Defaulted" } : x)));
      setEvents((e) => [{ id, value, price, expired, tx: fakeTx() }, ...e]);
      setLiq(null);
      setBusy(false);
      setToast({ k: "ok", m: `liquidate_collateral() simulada · préstamo #${id} → Defaulted` });
    }, 4300);
  };

  const onConnect = async () => {
    if (live) {
      await disconnectWallet().catch(() => undefined);
      setAddress(null);
      setSnap(null);
      setEvents([]);
      setToast({ k: "info", m: "Billetera desconectada: volviste al modo demo." });
      return;
    }
    try {
      const addr = await connectWallet();
      setAddress(addr);
      setToast({ k: "info", m: "Leyendo el contrato en testnet…" });
      await refresh(addr);
      usdcAssetName().then(setAssetName, () => setAssetName(null));
      setEvents([]);
      setToast({ k: "ok", m: `Conectada ${short(addr)} · operando contra el contrato en testnet.`, href: explorer.contract(CONTRACT_ID) });
    } catch (e) {
      const m = (e as { message?: string })?.message || "No se pudo conectar la billetera.";
      setToast({ k: "err", m });
    }
  };

  const onCopy = async (text: string, what: string) => {
    const ok = await copyText(text);
    setToast(ok ? { k: "ok", m: `${what} copiado al portapapeles.` } : { k: "err", m: "No pude copiar: seleccioná el texto y copialo a mano." });
  };

  const onRefreshAccount = async () => {
    if (!address) return;
    setBusy(true);
    setToast({ k: "info", m: "Consultando tu cuenta en testnet…" });
    try {
      const s = await readSnapshot(address);
      setSnap(s);
      const a = s.account;
      setToast(
        !a || !a.exists
          ? { k: "err", m: "Tu cuenta todavía no figura en testnet." }
          : !a.trustline
            ? { k: "err", m: "Todavía no veo la trustline al token del pool." }
            : a.usdc !== null && a.usdc > BigInt(0)
              ? { k: "ok", m: `Saldo actualizado: ${usd(fromU(a.usdc), 2)}. Ya podés depositar.`, href: explorer.account(address) }
              : { k: "err", m: "Tu saldo del token del pool sigue en 0: el pago del emisor todavía no llegó (o salió a otra cuenta).", href: explorer.account(address) },
      );
    } catch (e) {
      setToast({ k: "err", m: `No pude leer tu cuenta: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onFund = async () => {
    if (!address) return;
    setBusy(true);
    setToast({ k: "info", m: "Pidiendo XLM de prueba a Friendbot…" });
    try {
      await fundWithFriendbot(address);
      await refresh(address);
      setToast({ k: "ok", m: "Cuenta fondeada en testnet.", href: explorer.account(address) });
    } catch (e) {
      setToast({ k: "err", m: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onFaucet = async () => {
    if (!address) return;
    setBusy(true);
    setToast({ k: "info", m: "Pidiendo USDC de prueba al emisor…" });
    try {
      const r = await faucetUsdc(address);
      setTxs((t) => [{ fn: "faucet_usdc", hash: r.hash, at: new Date().toLocaleTimeString("es-AR") }, ...t].slice(0, 8));
      await refresh(address);
      setToast({ k: "ok", m: `Recibiste ${usd(r.amount)} de prueba.`, href: explorer.tx(r.hash) });
    } catch (e) {
      setToast({ k: "err", m: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /** Billetera de demo: crea la cuenta, la trustline y pide USDC sin extensión. */
  const onBurner = async () => {
    setBusy(true);
    try {
      const addr = await connectBurner();
      setAddress(addr);
      setToast({ k: "info", m: "Billetera de demo: fondeando con Friendbot…" });
      let s = await readSnapshot(addr);
      if (!s.account?.exists) {
        await fundWithFriendbot(addr);
        s = await readSnapshot(addr);
      }
      if (s.account && !s.account.trustline) {
        setToast({ k: "info", m: "Billetera de demo: creando la trustline al USDC de prueba…" });
        const h = await addUsdcTrustline(addr);
        setTxs((t) => [{ fn: "change_trust", hash: h, at: new Date().toLocaleTimeString("es-AR") }, ...t].slice(0, 8));
        s = await readSnapshot(addr);
      }
      if (s.account && (s.usdc ?? BigInt(0)) < toU(1000)) {
        setToast({ k: "info", m: "Billetera de demo: pidiendo USDC de prueba…" });
        const r = await faucetUsdc(addr);
        setTxs((t) => [{ fn: "faucet_usdc", hash: r.hash, at: new Date().toLocaleTimeString("es-AR") }, ...t].slice(0, 8));
        s = await readSnapshot(addr);
      }
      setSnap(s);
      usdcAssetName().then(setAssetName, () => setAssetName(null));
      setEvents([]);
      setToast({ k: "ok", m: `Billetera de demo ${short(addr)} lista: operás contra el contrato real en testnet.`, href: explorer.account(addr) });
    } catch (e) {
      setToast({ k: "err", m: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onTrust = async () => {
    if (!address) return;
    setBusy(true);
    setToast({ k: "info", m: "Firmá la trustline al USDC de prueba en tu billetera…" });
    try {
      const hash = await addUsdcTrustline(address);
      setTxs((t) => [{ fn: "change_trust", hash, at: new Date().toLocaleTimeString("es-AR") }, ...t].slice(0, 8));
      await refresh(address);
      setToast({ k: "ok", m: `Trustline creada · tx ${short(hash, 8, 6)}`, href: explorer.tx(hash) });
    } catch (e) {
      setToast({ k: "err", m: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const tone: [string, string] | null = toast
    ? toast.k === "ok"
      ? ["var(--greenbg)", "var(--green)"]
      : toast.k === "err"
        ? ["var(--badbg)", "var(--bad)"]
        : ["var(--goldbg)", "var(--gold)"]
    : null;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 w-full">
      <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-3xl font-bold">AgroBank</h1>
          <p className="mute text-sm">
            Crédito agro on-chain · Stellar Testnet · Soroban SDK v28{" "}
            <span className="px-2 py-0.5 rounded-full text-xs ml-1" style={{ background: live ? "var(--greenbg)" : "var(--goldbg)", color: live ? "var(--green)" : "var(--gold)" }}>
              {live ? "testnet en vivo" : "modo demo"}
            </span>
          </p>
          {CONTRACT_ID && (
            <p className="mute text-xs mt-1 mono">
              Contrato <ExplorerLink href={explorer.contract(CONTRACT_ID)}>{short(CONTRACT_ID, 6, 6)}</ExplorerLink>
              {live && snap && (
                <>
                  {" "}· Token del pool{" "}
                  <ExplorerLink href={explorer.contract(snap.tokenId)}>
                    {assetName ? `${assetName.split(":")[0]} (${short(assetName.split(":")[1] ?? "", 4, 4)})` : short(snap.tokenId, 6, 6)}
                  </ExplorerLink>
                </>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="btn btn2 text-sm"
            aria-label="Cambiar tema"
            onClick={() => setTheme((theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark" ? "light" : "dark")}
          >
            Tema
          </button>
          {!live && (
            <button className="btn btn2" disabled={busy} onClick={onBurner} title="Genera una cuenta de testnet en este navegador, sin extensión">
              Billetera de demo
            </button>
          )}
          <button className={live ? "btn btn2 mono" : "btn"} disabled={busy} onClick={onConnect}>
            {live && address ? `${isBurner() ? "Demo · " : ""}${short(address)} · ${view.wallet === null ? "—" : usd(view.wallet)}` : "Conectar billetera"}
          </button>
        </div>
      </header>
      <div role="tablist" className="flex gap-2 mb-5 flex-wrap">
        <button role="tab" className="tab" aria-selected={tab === "inv"} onClick={() => setTab("inv")}>Inversor</button>
        <button role="tab" className="tab" aria-selected={tab === "prod"} onClick={() => setTab("prod")}>Productor (eWarrants)</button>
        <button role="tab" className="tab" aria-selected={tab === "keep"} onClick={() => setTab("keep")}>Keeper / Liquidaciones</button>
      </div>
      {toast && tone && (
        <div role="status" className="mb-4 px-4 py-3 rounded-xl text-sm font-medium flex flex-wrap items-center justify-between gap-2" style={{ background: tone[0], color: tone[1] }}>
          <span>{toast.m}</span>
          {toast.href && <ExplorerLink href={toast.href} />}
        </div>
      )}
      {live && !snap && <div className="card p-5 mb-4 mute">Leyendo el contrato en testnet…</div>}
      {live && address && snap?.account && (
        <AccountSetup address={address} acct={snap.account} assetName={assetName} busy={busy} onFund={onFund} onTrust={onTrust} onRefresh={onRefreshAccount} onCopy={onCopy} onFaucet={onFaucet} />
      )}
      {tab === "inv" ? (
        <Investor v={view} a={actions} />
      ) : tab === "prod" ? (
        <Producer v={view} a={actions} price={price} />
      ) : (
        <Keeper v={view} price={price} setPrice={setPrice} busy={busy} liq={liq} events={events} liquidate={liquidate} />
      )}
      {txs.length > 0 && (
        <div className="card p-5 mt-4">
          <h2 className="text-lg font-semibold">Tus transacciones en testnet</h2>
          <ul className="mt-2 grid gap-2 text-sm">
            {txs.map((t) => (
              <li key={t.hash} className="flex flex-wrap justify-between gap-2">
                <span><code>{t.fn}()</code> <span className="mute mono">{short(t.hash, 8, 6)} · {t.at}</span></span>
                <ExplorerLink href={explorer.tx(t.hash)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer className="mute text-xs mt-8">
        {live
          ? "Modo testnet: las operaciones firmadas se envían al contrato real y se pueden auditar en StellarExpert. El precio de la soja es ilustrativo."
          : "Modo demo: datos simulados. Conectá una billetera de testnet (Freighter, xBull, Albedo…) para operar contra el contrato real."}{" "}
        Software experimental; no constituye asesoramiento financiero ni legal.
      </footer>
    </div>
  );
}
