# Guía de Stellar CLI (Testnet)

Todos los nombres de funciones y parámetros coinciden **1:1** con `contracts/agrobank-protocol/src/lib.rs`. Los montos están en unidades de 7 decimales (`1 USDC = 10_000_000`).

## Red (usar en todos los comandos)

Los comandos pasan la red explícita con `--rpc-url` y `--network-passphrase` en lugar del alias `--network testnet`: si el alias guardado en la CLI está mal configurado, falla con `client error (Connect)`.

```bash
RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

En PowerShell:

```powershell
$RPC_URL = "https://soroban-testnet.stellar.org"
$NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
```

## 0. Billeteras (mapeo de roles)

| Identidad CLI | Rol en el contrato |
|---|---|
| `agro-admin` | `admin` (firma `initialize` y `request_loan`) |
| `usdc-issuer` | Emisor del USDC de prueba |
| `agro-treasury` | `treasury` (recibe el 6% de spread) |
| `agro-investor` | `investor` |
| `agro-farmer` | `farmer` |

```bash
for k in agro-admin usdc-issuer agro-treasury agro-investor agro-farmer; do
  stellar keys generate --global $k --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" --fund
done

ADMIN=$(stellar keys address agro-admin)
ISSUER=$(stellar keys address usdc-issuer)
TREASURY=$(stellar keys address agro-treasury)
INVESTOR=$(stellar keys address agro-investor)
FARMER=$(stellar keys address agro-farmer)
```

## 1. USDC de prueba (SAC) y saldos

```bash
# Contrato SAC del USDC de prueba
USDC=$(stellar contract asset deploy \
  --asset USDC:$ISSUER --source usdc-issuer --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE")

# Trustlines (cuentas clásicas que reciben USDC)
for k in agro-treasury agro-investor agro-farmer; do
  stellar tx new change-trust --line USDC:$ISSUER --source $k --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE"
done

# Fondeo: 100.000 USDC al inversor, 20.000 al productor (para pagar intereses)
stellar tx new payment --source usdc-issuer --destination $INVESTOR \
  --asset USDC:$ISSUER --amount 1000000000000 --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE"
stellar tx new payment --source usdc-issuer --destination $FARMER \
  --asset USDC:$ISSUER --amount 200000000000 --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE"
```

> **Demo de una sola firma:** si vas a usar `FARMER=$ADMIN` (ver paso 5), `agro-admin` también necesita trustline y fondos de USDC. Repetí `change-trust` y el `payment` de 20.000 USDC para `agro-admin`.

## 2. Build y deploy

```bash
stellar contract build

BANK=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/agrobank_protocol.wasm \
  --source agro-admin --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" --alias agrobank)
echo $BANK
```

## 3. `initialize(admin, usdc, treasury, pyth_verifier, soy_feed_id)`

```bash
# Completar con los valores oficiales de Pyth Pro (ver docs/oracle_and_legal_framework.md §1.4)
PYTH_VERIFIER=<C...contrato verificador de Pyth Pro en Testnet>
SOY_FEED_ID=<feed id u32 de la soja>

stellar contract invoke --id $BANK --source agro-admin --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  initialize \
  --admin $ADMIN \
  --usdc $USDC \
  --treasury $TREASURY \
  --pyth_verifier $PYTH_VERIFIER \
  --soy_feed_id $SOY_FEED_ID

# Ejecutar justo después del deploy y verificar que el admin sea el esperado:
stellar contract invoke --id $BANK --source agro-admin --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- get_config
```

## 4. `deposit_liquidity(investor, amount)`

```bash
# 20.000 USDC
stellar contract invoke --id $BANK --source agro-investor --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  deposit_liquidity --investor $INVESTOR --amount 200000000000

stellar contract invoke --id $BANK --source agro-investor --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- pool_stats
# → [200000000000, 0, 0]   (total_shares, total_lent, acc_yield_per_share)
```

## 5. `request_loan(farmer, principal, collateral_tonnes, expiry_ledger, e_warrant_hash, price_update)`

```bash
PRINCIPAL=100000000000                 # 10.000 USDC
TONNES=50                              # 50 t × USD 400 = USD 20.000 (ratio 200% ≥ 130%)
LEDGER_NOW=<ledger actual, ver explorador de testnet>
EXPIRY=$((LEDGER_NOW + 6307200))       # ≈ 365 días; start_ledger es el ledger de la tx, así que los montos serán levemente menores a la tabla
WARRANT_HASH=$(printf 'eWarrant-640-2024-0001' | sha256sum | cut -d' ' -f1)  # BytesN<32>
PYTH_UPDATE_HEX=<payload leEcdsa firmado de Pyth Pro, en hexadecimal>
```

`request_loan` exige **dos autorizaciones** (`admin` y `farmer`) y la CLI solo firma por la cuenta `--source`. Con `--source agro-farmer` la tx falla por falta de la autorización del admin.

**Demo rápido (una sola firma):** el admin actúa también como productor. Definí `FARMER=$ADMIN` y usá `--source agro-admin` en los pasos 5 y 6.

```bash
FARMER=$ADMIN
stellar contract invoke --id $BANK --source agro-admin --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  request_loan \
  --farmer $FARMER \
  --principal $PRINCIPAL \
  --collateral_tonnes $TONNES \
  --expiry_ledger $EXPIRY \
  --e_warrant_hash $WARRANT_HASH \
  --price_update $PYTH_UPDATE_HEX
# → 0   (loan_id)
```

Para roles separados hay que firmar la entrada de autorización del admin por separado (`--build-only` → `stellar tx simulate` → firmas → `stellar tx send`; ver `stellar tx sign --help`).

Repetir el mismo `--e_warrant_hash` falla con `WarrantAlreadyPledged` (#8). Sub-colateralizado falla con `Undercollateralized` (#10).

## 6. `repay_loan(farmer, loan_id)` — Split Atómico

> Si usaste el demo de una sola firma, reemplazá `--source agro-farmer` por `--source agro-admin`.

```bash
stellar contract invoke --id $BANK --source agro-farmer --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  repay_loan --farmer $FARMER --loan_id 0
```

En **una sola transacción**, desde la billetera del productor:

| Destino | Monto (plazo 365 d exactos, como en los tests) |
|---|---:|
| Pool (`$BANK`): capital + 12% | 11.200 USDC (`112000000000`) |
| Tesorería (`$TREASURY`): 6% | 600 USDC (`6000000000`) |
| **Total pagado por el productor** | **11.800 USDC** |

Si cualquiera de las dos transferencias falla, se revierte todo.

## 7. `claim_yield(investor)` y `withdraw_liquidity(investor, amount)`

```bash
stellar contract invoke --id $BANK --source agro-investor --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  claim_yield --investor $INVESTOR
# → ~12000000000 (1.200 USDC; hasta 1 unidad de polvo por redondeo)

stellar contract invoke --id $BANK --source agro-investor --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  withdraw_liquidity --investor $INVESTOR --amount 200000000000
```

## 8. `liquidate_collateral(loan_id, price_update)`

Permisionless: cualquier *keeper* puede invocarla. Requiere un préstamo `Active`: el `loan_id 0` ya fue repagado en el paso 6 y el paso 7 retiró todo el capital, así que antes de originar el segundo préstamo hay que reponer liquidez libre:

```bash
stellar contract invoke --id $BANK --source agro-investor --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  deposit_liquidity --investor $INVESTOR --amount 200000000000
```

Luego originá el 2.º préstamo (paso 5 con otro `WARRANT_HASH`; su `loan_id` será `1`). Para probar el vencimiento sin oráculo usá `EXPIRY=$((LEDGER_NOW + 20))` (≈ 100 s) y, pasado ese ledger, `--price_update 00`: por vencimiento el contrato no lee Pyth.

```bash
stellar contract invoke --id $BANK --source agro-treasury --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- \
  liquidate_collateral --loan_id 1 --price_update $PYTH_UPDATE_HEX
# → "Defaulted" si (ledger > expiry_ledger) o (valor del colateral según Pyth < 130% del principal)
# → NotLiquidatable (#11) si el préstamo está sano
```

Tras `Defaulted`, la ejecución física del eWarrant [Decreto 640/2024] se coordina off-chain con el depositario.

## Vistas

```bash
stellar contract invoke --id $BANK --source agro-admin --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- get_loan --loan_id 0
stellar contract invoke --id $BANK --source agro-admin --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- get_investor --investor $INVESTOR
stellar contract invoke --id $BANK --source agro-admin --rpc-url $RPC_URL --network-passphrase "$NETWORK_PASSPHRASE" -- pool_stats
```

<sub>© 2026 Romi · psyduckLabs</sub>
