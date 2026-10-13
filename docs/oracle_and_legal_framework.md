# Oráculo y marco legal

## 1. Integración con Pyth Pro (modelo pull)

### 1.1 Flujo

| Paso | Dónde | Qué pasa |
|---|---|---|
| 1 | Off-chain | El keeper o el frontend se suscribe a Pyth Pro con `formats: ["leEcdsa"]`, el formato requerido en Stellar. |
| 2 | Off-chain | Recibe el update firmado del feed de soja como `Bytes`. |
| 3 | On-chain | `request_loan` o `liquidate_collateral` reciben ese `price_update`. |
| 4 | On-chain | Una llamada cross-contract al verificador de Pyth comprueba la firma ECDSA y decodifica el precio. |
| 5 | On-chain | `read_soy_price` aplica las reglas de AgroBank y emite `OraclePriceUsed`. |

- **La firma la verifica el contrato verificador de Pyth**, no `lib.rs`.
- AgroBank confía únicamente en la dirección `pyth_verifier` fijada en `initialize`.

### 1.2 Protección en Rust (`read_soy_price`)

```rust
pub const MAX_PRICE_AGE_SECS: u64 = 60;
pub const MAX_FUTURE_SKEW_SECS: u64 = 5;

let v = PythVerifierClient::new(env, &cfg.pyth_verifier).verify_update(&update);
if v.feed_id != cfg.soy_feed_id { return Err(Error::WrongFeed); }
if v.price <= 0                 { return Err(Error::InvalidPrice); }
let now_us = env.ledger().timestamp().checked_mul(1_000_000).ok_or(Error::MathOverflow)?;
if v.publish_time_us > now_us.saturating_add(MAX_FUTURE_SKEW_SECS * 1_000_000) {
    return Err(Error::FuturePrice);
}
if now_us.saturating_sub(v.publish_time_us) > MAX_PRICE_AGE_SECS * 1_000_000 {
    return Err(Error::StalePrice);
}
```

| Control | Regla | Error |
|---|---|---|
| Feed | `feed_id == soy_feed_id` | `WrongFeed` (#16) |
| Precio | `price > 0` | `InvalidPrice` (#15) |
| Frescura | Antigüedad ≤ 60 s (en µs) | `StalePrice` (#14) |
| Reloj | Timestamp ≤ ahora + 5 s | `FuturePrice` (#20) |
| Auditoría | Cada precio aceptado se publica | Evento `OraclePriceUsed` |

Los tests `rejects_stale_and_future_prices` y `liquidation_by_price_and_by_expiry` lo cubren usando `MockPyth`.

### 1.3 Ajuste del exponente (soja)

Pyth publica `price × 10^exponent` en USD por tonelada. USDC usa 7 decimales.

```
shift      = exponent + USDC_DECIMALS          // ej.: −8 + 7 = −1
valor_usdc = toneladas × price × 10^shift      // shift < 0 → división entera
```

| Toneladas | `price` | `exponent` | Precio real | Valor (unidades USDC) |
|---:|---:|---:|---:|---:|
| 50 | 40.000.000.000 | −8 | USD 400/t | 200.000.000.000 (= 20.000 USDC) |

- Se usa `checked_mul` y `checked_pow` en todo el cálculo: un overflow devuelve `MathOverflow` (#12).
- Test que lo cubre: `value_with_negative_exponent`.

### 1.4 Adaptador y migración pendiente

| Hoy (MVP) | Producción |
|---|---|
| `PythVerifierInterface::verify_update(Bytes) -> VerifiedPrice` (plano) | `PythLazerClient` (crate `pyth-lazer-stellar-sdk`) |
| Un precio por update | Update con varios `feeds`, cada uno con `price`, `exponent` y `feed_update_timestamp` opcionales |
| `MockPyth` en los tests | Verificador oficial (mainnet: `CACZ3GBAKUPIAFRILUFO27J5RUH5GJ2VSJ46LP6GJYSKGDRTQ5MS3HCH`) |

- La migración solo toca `PythVerifierInterface` y `read_soy_price`.
- Falta confirmar el verificador de Testnet y que exista un feed de soja en Pyth Pro.
- Docs: <https://docs.pyth.network/price-feeds/pro/integrate-as-consumer/stellar>

## 2. Respaldo jurídico

### 2.1 Normativa

| Norma | Aporte |
|---|---|
| Ley 9.643 (1914) | Régimen de warrants y certificados de depósito. |
| DNU 70/2023 | Moderniza la Ley 9.643. |
| **Decreto 640/2024** | Warrants de libre emisión, sin obligación de inscribirse en el Registro de Warranteras, con emisión y negociación electrónica en plataformas públicas o privadas. |

- Análisis del decreto: [Marval O'Farrell Mairal — Developments Regarding Warrants](https://www.marval.com/Publicacion/novedades-en-el-mercado-de-warrants-16905?lang=en)
- Texto oficial: [Boletín Oficial de la República Argentina](https://www.boletinoficial.gob.ar)

### 2.2 Tokenización del eWarrant

| Elemento | Implementación |
|---|---|
| Identidad del colateral | `e_warrant_hash: BytesN<32>` (SHA-256 del eWarrant). |
| Anti doble pignoración | `DataKey::Warrant(hash) → loan_id`; si ya existe, `WarrantAlreadyPledged` (#8). |
| Liberación | `repay_loan` borra la clave y el hash vuelve a quedar disponible. |
| Atestación | El `admin` cofirma `request_loan`: valida el eWarrant y el score de Cartas de Porte off-chain. |
| Documentación | Supabase guarda el eWarrant y el historial en `warrant_pledges`. |

- El decreto elimina la **obligación de inscripción** como warrantera, pero el grano sigue necesitando un **depositario** que lo custodie.
- El hash on-chain prueba integridad y unicidad; **no reemplaza** la validez jurídica del documento.

### 2.3 Estado `Defaulted` y ejecución física

| Paso | Capa | Acción |
|---|---|---|
| 1 | On-chain | Un keeper llama a `liquidate_collateral` cuando el préstamo venció o el ratio quedó bajo el 130%. |
| 2 | On-chain | El préstamo pasa a `Defaulted` y se emite `LoanDefaulted { expired, collateral_value }`. |
| 3 | Off-chain | El indexador registra el evento y bloquea el hash en `warrant_pledges.defaulted_ledger`. |
| 4 | Off-chain | El operador notifica al depositario o acopio donde está la soja. |
| 5 | Off-chain | El eWarrant se ejecuta según el procedimiento de la Ley 9.643 y el grano se vende. |
| 6 | Off-chain → on-chain | El recupero vuelve al pool. En el MVP es manual; ver roadmap. |

- `liquidate_collateral` **solo cambia el estado**: no mueve fondos ni grano.
- El principal de un préstamo `Defaulted` sigue contando en `total_lent` hasta el recupero.

### 2.4 Salvedades

- La captación de fondos del público puede quedar alcanzada por la CNV (oferta pública y proveedores de activos virtuales) y por la UIF (prevención de lavado).
- La estructura del pool y la ejecución ante mora requieren un dictamen legal especializado.
- Este documento es informativo y no constituye asesoramiento legal.

---

<sub>© 2026 Romi · psyduckLabs</sub>
