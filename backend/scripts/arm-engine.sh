#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# FILL — arm the engine
# Reads PROTOCOL_PRIVATE_KEY from backend/.env (never from args,
# never stored in shell history), sets it on Railway, then polls
# the live API until the engine confirms it can sign.
# Usage:  bash backend/scripts/arm-engine.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

API="https://fill-backend-production.up.railway.app/api/v1/status"

KEY="$(grep -m1 '^PROTOCOL_PRIVATE_KEY=' .env | cut -d= -f2-)"
if [ -z "${KEY}" ]; then
  echo "❌ No PROTOCOL_PRIVATE_KEY found in backend/.env"; exit 1
fi

echo "──────────────────────────────────────────────────────"
echo " 1/3  BACK THIS KEY UP in a password manager NOW:"
echo ""
echo "      ${KEY}"
echo ""
echo "      (if your laptop dies, this key IS the protocol)"
echo "──────────────────────────────────────────────────────"
printf " Press Enter once it is saved… "
read -r _

echo " 2/3  Setting PROTOCOL_PRIVATE_KEY on Railway…"
railway variables --service fill-backend --set "PROTOCOL_PRIVATE_KEY=${KEY}" >/dev/null
echo "      set ✓ (Railway is redeploying)"

echo " 3/3  Waiting for the engine to confirm it can sign…"
for i in $(seq 1 30); do
  sleep 10
  LOADED="$(curl -s --max-time 10 "${API}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['wallet']['signerLoaded'])" 2>/dev/null || echo '?')"
  echo "      check ${i}/30 → signerLoaded=${LOADED}"
  if [ "${LOADED}" = "True" ]; then
    echo ""
    echo "✅ ENGINE ARMED — the protocol wallet can sign transactions."
    echo "   Next: fund 0x2cdE129778a416279d9f6F1E9B5c3abb302D1CD7"
    echo "     • USDC on Arbitrum One   (perp collateral)"
    echo "     • ETH on Arbitrum One    (gas for trades)"
    echo "     • ETH on Robinhood Chain (gas for fee claims + buybacks)"
    exit 0
  fi
done

echo "⚠️  Timed out waiting for the redeploy — check the Railway dashboard logs."
exit 1
