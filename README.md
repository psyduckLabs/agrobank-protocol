# 🌾 AgroBank Protocol

**Crédito agrícola on-chain para Argentina: USDC contra eWarrants de soja, sobre Stellar Soroban.**

![Status](https://img.shields.io/badge/status-MVP%20%C2%B7%20Testnet-orange)
![SDK](https://img.shields.io/badge/soroban--sdk-v28-purple)
![Oracle](https://img.shields.io/badge/oracle-Pyth%20Pro%20%C2%B7%20Pull%20Model-6E3FF3)
![Tests](https://img.shields.io/badge/tests-8%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

```bash
git clone https://github.com/psyduckLabs/agrobank-protocol.git
```

---

## 🎯 Problema → Solución

| | Hoy en el agro argentino | Con AgroBank |
|---|---|---|
| **Acceso al crédito** | Tasas altas en pesos y garantías lentas de ejecutar. | Crédito en USDC respaldado por soja almacenada. |
| **Garantía** | Warrant en papel, con un circuito de warranteras. | eWarrant digital [Decreto 640/2024] bloqueado on-chain por hash. |
| **Fondeo** | Bancos e intermediarios cerrados. | Pool abierto de inversores con rendimiento del 12% TNA. |
| **Transparencia** | Spread opaco. | Spread del 6% visible y separado en la misma transacción del repago. |
| **Riesgo de precio** | Tasaciones manuales. | Precio de Pyth Pro verificado on-chain, con antigüedad máxima de 60 s. |

- **Productor:** pide USDC contra un eWarrant con colateral mínimo del **130%**.
- **Inversor:** deposita USDC y cobra el **12% TNA** de los intereses repagados.
- **Tesorería:** recibe el **6%** de spread en la misma transacción del repago.
- **Keeper:** liquida sin permisos si el préstamo vence o el colateral cae bajo el 130%.

---

## 🗂️ Arquitectura del repositorio

```
agrobank-protocol/
├── contracts/
│   └── agrobank-protocol/
│       ├── Cargo.toml          # crate cdylib (soroban-sdk workspace = "28")
│       ├── src/lib.rs          # contrato core + 8 tests con MockPyth
│       └── test_snapshots/
├── packages/
│   └── agrobank-client/        # bindings TypeScript generados (@agrobank/client)
├── apps/
│   └── web/                    # frontend Next.js (en desarrollo)
├── supabase/
│   └── migrations/             # esquema off-chain + alineación ledgers/bps (RLS)
├── scripts/rpc/                # consultas RPC de Stellar
├── docs/                       # documentación detallada (ver índice)
├── index.html                  # dApp interactiva: Inversor · Productor · Keeper
├── Cargo.toml                  # workspace Rust: members = ["contracts/*"]
├── package.json                # scripts pnpm
└── pnpm-workspace.yaml         # apps/* + packages/*
```

---

## ⚡ Inicio rápido

**Requisitos:** Node 18+, pnpm, Rust con target `wasm32v1-none` y Stellar CLI.

```bash
# 1. Dependencias
pnpm install

# 2. Compilar el WASM y generar los bindings TypeScript
pnpm bindings          # → packages/agrobank-client
pnpm contracts:test    # → 8 tests OK

# 3. Abrir la dApp interactiva
npx serve .            # y entrar a http://localhost:3000/index.html
```

- `index.html` también abre con doble clic, pero necesita internet porque carga React (htm) y Tailwind por CDN.
- El dashboard calcula el interés con la misma fórmula entera (BigInt) que `lib.rs`.

---

## 📚 Documentación detallada

| Documento | Contenido |
|---|---|
| [Arquitectura y tokenómica](docs/architecture_and_tokenomics.md) | Spread de 18/12/6, cálculo por ledgers, reparto del rendimiento y ciclo de vida de los métodos. |
| [Oráculo y marco legal](docs/oracle_and_legal_framework.md) | Pyth Pro (pull, leEcdsa, frescura, exponente) y el Decreto 640/2024 aplicado al estado `Defaulted`. |
| [Auditoría y roadmap](docs/audit_and_roadmap.md) | Hallazgos de consistencia corregidos, riesgos abiertos y pasos hacia producción. |
| [Guía Stellar CLI (Testnet)](docs/testnet_cli_guide.md) | Deploy, `initialize` y cada llamada con comandos listos. |

---

## 🧱 Stack

| Capa | Tecnología |
|---|---|
| Contrato | Rust · `soroban-sdk = "28"` · `wasm32v1-none` |
| Activo | USDC (Stellar Asset Contract, 7 decimales) |
| Oráculo | Pyth Pro (modelo pull, formato `leEcdsa`) |
| Off-chain | Supabase Postgres con RLS |
| Frontend | React (htm) + Tailwind (demo) · Next.js (`apps/web`) |

---

<sub>© 2026 Romi · psyduckLabs · MIT. Software experimental sin auditar; nada de esto es oferta de inversión ni asesoramiento legal o financiero.</sub>
