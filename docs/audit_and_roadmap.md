# Auditoría interna y roadmap

> Revisión de consistencia entre contrato, dashboard y capa off-chain. **No reemplaza una auditoría externa.**

## 1. Alcance

| Componente | Archivo |
|---|---|
| Contrato | `contracts/agrobank-protocol/src/lib.rs` |
| Build | `Cargo.toml` (raíz) · `contracts/agrobank-protocol/Cargo.toml` |
| Dashboard | `index.html` |
| Off-chain | `supabase/migrations/20261012040948_init_schema.sql` · `20261013000000_align_contract_ledgers_bps.sql` |

## 2. Hallazgos corregidos

| ID | Área | Hallazgo | Corrección | Estado |
|---|---|---|---|---|
| A-01 | Build | Faltaba `Cargo.toml` en `contracts/agrobank-protocol/` y la ruta no coincidía con `members = ["contracts/*"]`. | Se agregó el crate con `crate-type = ["lib","cdylib"]` y `soroban-sdk = { workspace = true }`. | ✅ |
| A-02 | Dashboard | El interés se calculaba plano y anualizado, distinto del contrato. | Se usa `interestFor()` en BigInt con `DAY = 17280` y `LEDGERS_PER_YEAR = 6_307_200`, con división entera. | ✅ |
| A-03 | SQL | `loans` no tenía `start_ledger` ni tasas en bps. | Se agregaron `start_ledger`, `interest_rate_bps` (1800) e `investor_yield_bps` (1200), con checks de plazo y tasas. | ✅ |
| A-04 | SQL | Typo `Perprofiles`. | La tabla se llama `profiles`; se agregaron `cuit`, `carta_porte_score` y validación de wallet `G…`/`C…`. | ✅ |
| A-05 | SQL | El indexador no podía replicar el repago exacto. | Función `agrobank_interest()` (floor) y vista `loan_repayment_quotes`, equivalentes a `split_interest`. | ✅ |
| A-06 | SQL | Una restricción `unique` en `e_warrant_hash` chocaba con la liberación del hash al repagar. | Índice único parcial (`Active`, `Defaulted`) y tabla `warrant_pledges` con el historial. | ✅ |
| A-07 | SQL | Los precios del oráculo usados no quedaban registrados. | Tabla `oracle_audit`, alimentada por el evento `OraclePriceUsed`. | ✅ |
| A-08 | SQL | Los keepers no podían ver los préstamos activos por la RLS. | Política `keepers see active loans` para el rol `keeper`. | ✅ |

**Verificación cruzada (10.000 USDC a 365 días):**

| Capa | Total | Pool | Tesorería |
|---|---:|---:|---:|
| `lib.rs` (test) | 1.800 | 11.200 | 600 |
| `index.html` | 1.800 | 11.200 | 600 |
| `loan_repayment_quotes` | 1.800 | 11.200 | 600 |

## 3. Riesgos abiertos

| ID | Severidad | Riesgo | Mitigación propuesta |
|---|---|---|---|
| O-01 | Alta | Adaptador Pyth plano, distinto de `PythLazerClient`. | Migrar `PythVerifierInterface` y `read_soy_price`. |
| O-02 | Alta | Captura JIT del rendimiento en `repay_loan`. | Devengo continuo por ledger o ventana de entrada. |
| O-03 | Alta | Sin fondo de reserva: un préstamo `Defaulted` no socializa la pérdida. | Fondo alimentado por una parte del spread. |
| O-04 | Media | El TTL de `Loan` y `Warrant` es de 60 días y el plazo puede llegar a 365. | Subir el TTL al plazo o documentar el restore. |
| O-05 | Media | Admin único, sin rotación ni pausa. | Multisig y función `pause`. |
| O-06 | Media | Un tercero podría adelantarse a `initialize` después del deploy. | Deploy e inicialización en un mismo script, más verificación con `get_config`. |
| O-07 | Baja | Interés sobre plazo pactado: sin descuento por repago anticipado ni recargo por mora. | Devengo por ledgers transcurridos más punitorio. |
| O-08 | Baja | `LoanRepaid` y `LoanDefaulted` no incluyen wallet. | El indexador la completa con `loans.farmer` a partir del `loan_id`. |

## 4. Roadmap hacia producción

| Fase | Entregable | Criterio de salida |
|---|---|---|
| **1 · Oráculo real** | `PythLazerClient`, verificador de Testnet y feed de soja confirmado | Tests de integración con updates `leEcdsa` reales |
| **2 · Economía** | Devengo continuo (cierra O-02 y O-07) y fondo de reserva (O-03) | Simulación de utilización al 40/60/80% y de defaults |
| **3 · Bindings WASM** | `@agrobank/client` integrado en `apps/web`, reemplazando la simulación | Ciclo completo firmado con wallet en Testnet |
| **4 · Indexador** | Worker que lee los eventos por RPC (`getEvents`) y los vuelca a `chain_events`, `loans`, `warrant_pledges` y `oracle_audit` | Reconciliación diaria on-chain vs. Supabase sin diferencias |
| **5 · Gobernanza** | Multisig, `pause` y TTL ajustado (O-04, O-05) | Runbook de operación |
| **6 · Auditoría externa** | Revisión de seguridad del contrato | Hallazgos críticos y altos cerrados |
| **7 · Piloto** | Mainnet con topes bajos y depositarios reales | Primer ciclo de campaña repagado |

En paralelo: dictamen legal (CNV/UIF) y convenios con depositarios y acopios.

---

<sub>© 2026 Romi · psyduckLabs</sub>
