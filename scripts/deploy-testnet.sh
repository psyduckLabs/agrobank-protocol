#!/usr/bin/env bash
# Despliega AgroBank en Testnet: verificador de precios, USDC de prueba (SAC),
# contrato principal y liquidez inicial. Escribe las direcciones en deployments/testnet.json.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC_URL=https://soroban-testnet.stellar.org
NP="Test SDF Network ; September 2015"
NET=(--rpc-url "$RPC_URL" --network-passphrase "$NP")
SOY_FEED_ID=7

for k in agro-admin agro-oracle usdc-issuer agro-treasury agro-investor; do
  stellar keys address $k >/dev/null 2>&1 || stellar keys generate $k "${NET[@]}" --fund >/dev/null
  stellar keys fund $k "${NET[@]}" >/dev/null 2>&1 || true
done
ADMIN=$(stellar keys address agro-admin); ISSUER=$(stellar keys address usdc-issuer)
TREASURY=$(stellar keys address agro-treasury); INVESTOR=$(stellar keys address agro-investor)
ORACLE_HEX=$(python3 -c "import base64,sys;print(base64.b32decode(sys.argv[1])[1:33].hex())" "$(stellar keys address agro-oracle)")

stellar contract build >/dev/null
VERIFIER=$(stellar contract deploy --wasm target/wasm32v1-none/release/price_verifier.wasm --source agro-admin "${NET[@]}")
stellar contract invoke --id $VERIFIER --source agro-admin "${NET[@]}" -- initialize --admin $ADMIN --signer $ORACLE_HEX >/dev/null

USDC=$(stellar contract id asset --asset USDC:$ISSUER "${NET[@]}")
stellar contract asset deploy --asset USDC:$ISSUER --source usdc-issuer "${NET[@]}" >/dev/null 2>&1 || true

BANK=$(stellar contract deploy --wasm target/wasm32v1-none/release/agrobank_protocol.wasm --source agro-admin "${NET[@]}")
stellar contract invoke --id $BANK --source agro-admin "${NET[@]}" -- initialize \
  --admin $ADMIN --usdc $USDC --treasury $TREASURY --pyth_verifier $VERIFIER --soy_feed_id $SOY_FEED_ID >/dev/null

for k in agro-treasury agro-investor agro-admin; do
  stellar tx new change-trust --line USDC:$ISSUER --source $k "${NET[@]}" >/dev/null 2>&1 || true
done
stellar tx new payment --source usdc-issuer --destination $INVESTOR --asset USDC:$ISSUER --amount 10000000000000 "${NET[@]}" >/dev/null
# 500.000 USDC de liquidez inicial en el pool
stellar contract invoke --id $BANK --source agro-investor "${NET[@]}" -- deposit_liquidity --investor $INVESTOR --amount 5000000000000 >/dev/null

mkdir -p deployments
cat > deployments/testnet.json <<JSON
{
  "network": "testnet",
  "rpcUrl": "$RPC_URL",
  "networkPassphrase": "$NP",
  "agrobank": "$BANK",
  "priceVerifier": "$VERIFIER",
  "usdc": "$USDC",
  "usdcAsset": "USDC:$ISSUER",
  "admin": "$ADMIN",
  "treasury": "$TREASURY",
  "seedInvestor": "$INVESTOR",
  "oracleSignerHex": "$ORACLE_HEX",
  "soyFeedId": $SOY_FEED_ID,
  "deployedAt": "$(date -u +%FT%TZ)"
}
JSON
cat deployments/testnet.json
stellar contract invoke --id $BANK --source agro-admin "${NET[@]}" -- pool_stats
