// E2E contra Stellar Testnet real: recorre el ciclo completo del MVP desde la UI
// con la billetera de demo (sin extensión) y guarda capturas + hashes de las tx.
// Uso: BASE_URL=https://agro-bank.vercel.app node e2e/testnet-cycle.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");

const BASE = process.env.BASE_URL || "http://localhost:3317";
const OUT = process.env.OUT_DIR || "docs/screenshots";
mkdirSync(OUT, { recursive: true });
const log = [];
const proofs = [];
const step = (m) => { console.log("·", m); log.push(m); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", String(e)));

const DETAIL = {
  deposit_liquidity: "El inversor deposita 1.000 USDC en el pool.",
  "request_loan #1": "500 t a USD 380/t, 50.000 USDC a 180 días. Admin cofirma, el oráculo firma el precio.",
  repay_loan: "Split atómico: capital + 12% al pool y 6% a tesorería.",
  claim_yield: "El inversor cobra el rendimiento generado por el repago.",
  "request_loan #2": "160 t, 45.000 USDC: cobertura del 135%.",
  liquidate_collateral: "La soja cae a USD 250/t: el keeper liquida con un precio firmado.",
};
const toast = () => page.locator('div[role="status"]').first();
async function waitOk(label, timeout = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const txt = (await toast().textContent().catch(() => "")) || "";
    const fn = label.split(" ")[0];
    const okFor = label === "billetera de demo" ? /lista/.test(txt) : txt.includes(fn + "()") && /confirmada/.test(txt);
    if (okFor) {
      step(`${label}: ${txt.trim().slice(0, 140)}`);
      const href = (await toast().locator("a").first().getAttribute("href").catch(() => null)) || "";
      const m = href.match(/\/tx\/([0-9a-f]{64})/);
      if (m) proofs.push({ label, detail: DETAIL[label] || "", hash: m[1] });
      return txt;
    }
    if (/rechaz|falló|Error|inválid|insuficiente|No pude/i.test(txt) && !/Simulando|esperando/.test(txt)) throw new Error(`${label}: ${txt}`);
    await page.waitForTimeout(800);
  }
  throw new Error(`${label}: timeout`);
}
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const tab = (name) => page.getByRole("tab", { name }).click();

// 0. Landing
const land = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await land.goto(BASE + "/", { waitUntil: "load" });
await land.waitForTimeout(1500);
await land.screenshot({ path: `${OUT}/01-landing-hero.png` });
await land.locator("#en-vivo").scrollIntoViewIfNeeded().catch(() => {});
await land.waitForTimeout(2500);
await land.locator("#en-vivo").screenshot({ path: `${OUT}/02-landing-en-vivo.png` }).catch(() => {});
await land.locator("#simulador").screenshot({ path: `${OUT}/03-landing-simulador.png` });
await land.close();

// 1. Billetera de demo: Friendbot + trustline + faucet
await page.goto(BASE + "/app", { waitUntil: "load" });
await page.getByRole("button", { name: "Billetera de demo" }).click();
await waitOk("billetera de demo", 180_000);
await page.waitForTimeout(1500);

// 2. Inversor: depósito
await tab("Inversor");
await page.locator("#dep").fill("1000");
await page.getByRole("button", { name: "Depositar USDC" }).click();
await waitOk("deposit_liquidity");
await shot("04-app-inversor");

// 3. Productor: request_loan con cofirma del admin y precio firmado
await tab("Productor (eWarrants)");
await page.locator("#tn").fill("500");
await page.locator("#pr").fill("50000");
await page.locator("#dy").fill("180");
await page.getByRole("button", { name: "Hash de prueba" }).click();
await page.getByRole("button", { name: "Solicitar crédito", exact: true }).click();
await waitOk("request_loan #1");
await page.waitForTimeout(2000);
await shot("05-app-credito-originado");

// 4. Repago con split atómico
await page.getByRole("button", { name: /^Repagar/ }).first().click();
await waitOk("repay_loan");

// 5. Inversor cobra el rendimiento generado por el repago
await tab("Inversor");
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /Cobrar rendimiento/ }).click();
await waitOk("claim_yield");

// 6. Segundo crédito cerca del límite y liquidación por caída de precio
await tab("Productor (eWarrants)");
await page.locator("#tn").fill("160");
await page.locator("#pr").fill("45000");
await page.getByRole("button", { name: "Hash de prueba" }).click();
await page.getByRole("button", { name: "Solicitar crédito", exact: true }).click();
await waitOk("request_loan #2");
await tab("Keeper / Liquidaciones");
await page.locator('input[type="range"]').fill("250");
await page.waitForTimeout(800);
await page.getByRole("button", { name: "Liquidar on-chain" }).last().click();
await waitOk("liquidate_collateral");
await page.waitForTimeout(1500);
await shot("06-app-liquidacion");
await page.locator("text=Tus transacciones en testnet").scrollIntoViewIfNeeded();
await page.screenshot({ path: `${OUT}/07-app-transacciones.png`, fullPage: true });

const txs = await page.$$eval('a[href*="stellar.expert/explorer/testnet/tx/"]', (as) => [...new Set(as.map((a) => a.href))]);
const rows = await page.$$eval("li", (ls) => ls.map((l) => l.textContent).filter((t) => t && /\(\)/.test(t)));
const out = { base: BASE, at: new Date().toISOString(), steps: log, txs: proofs, allTxLinks: txs, rows };
writeFileSync(`${OUT}/../e2e-proofs.json`, JSON.stringify(out, null, 2));
if (process.env.PROOFS_PUBLIC) writeFileSync(process.env.PROOFS_PUBLIC, JSON.stringify(out, null, 2));
step(`listo: ${txs.length} tx con enlace`);
await browser.close();
