#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Wialon Notification Test Script
# Source: Livraison 01-04-2026.1_updated-with-order.xlsx
# Email recipient (from E-mail client column): alanic.nguetsa@camtrack.net
#
# Vehicles & trajectories used:
#   1498TBH  → Parking DEPOT RAFFINERIE TERMINAL → DEPOT RAFFINERIE TERMINAL → PENTA-OCEAN TMM PBF
#   3277TBM  → Parking DEPOT ALAROBIA.           → DEPOT ALAROBIA.           → STATION SOAVA NG PBF → STATION ANKORONDRANO PBF → ...
#   4730DJ   → Parking DEPOT MAHAJANGA           → DEPOT MAHAJANGA           → STATION ATAFANA PBF → SS DOMOINA NG PBF → ...
#   5282TBA  → Parking DEPOT ALAROBIA.           → DEPOT ALAROBIA.           → STATION ANJOMA PBF → SS TALATAMATY NG PBF → ...
#   7618AF   → Parking DEPOT RAFFINERIE TERMINAL → DEPOT RAFFINERIE TERMINAL → SS BARIKADIMY PBF → ...
#   7618AF-RENAULT KWID-GALANA (long name test)  → same vehicle, cut at first dash
# ─────────────────────────────────────────────────────────────────────────────

BASE_URL="http://localhost:5458"
ENDPOINT="$BASE_URL/wialon-notify"

echo ""
echo "========================================================================"
echo " Wialon Notification Tests — Livraison 01-04-2026"
echo " Email goes to: alanic.nguetsa@camtrack.net (from E-mail client column)"
echo "========================================================================"

# ── [1] arrived_parking ───────────────────────────────────────────────────────
# 1498TBH arrives at Parking DEPOT RAFFINERIE TERMINAL
echo ""
echo "--- [1/7] arrived_parking: 1498TBH → Parking DEPOT RAFFINERIE TERMINAL ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 1498TBH est arrivé au point de livraison Parking DEPOT RAFFINERIE TERMINAL. A 2026-04-01 06:05:00 à une Vitesse de 12 km/h près de '\''Terminal, Toamasina, Atsinanana, Madagascar, 0.3 km from Terminal'\''.":""}' \
  && echo "" && echo "✅ sent → expect: Arrivée à l'\''étape Parking DEPOT RAFFINERIE TERMINAL"

sleep 2

# ── [2] arrived_depot ─────────────────────────────────────────────────────────
# 1498TBH arrives at DEPOT RAFFINERIE TERMINAL (no Parking prefix)
echo ""
echo "--- [2/7] arrived_depot: 1498TBH → DEPOT RAFFINERIE TERMINAL ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 1498TBH est arrivé au point de livraison DEPOT RAFFINERIE TERMINAL. A 2026-04-01 07:02:00 à une Vitesse de 18 km/h près de '\''Terminal, Toamasina, Atsinanana, Madagascar, 0.5 km from Terminal'\''.":""}' \
  && echo "" && echo "✅ sent → expect: Arrivée à l'\''étape DEPOT RAFFINERIE TERMINAL"

sleep 2

# ── [3] arrived_client ────────────────────────────────────────────────────────
# 3277TBM arrives at client STATION SOAVA NG PBF (trajet 2)
echo ""
echo "--- [3/7] arrived_client: 3277TBM → STATION SOAVA NG PBF ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 3277TBM est arrivé au point de livraison STATION SOAVA NG PBF. A 2026-04-01 08:20:00 à une Vitesse de 35 km/h près de '\''Soava, Antananarivo, Madagascar, 0.95 km from Soava'\''.":""}' \
  && echo "" && echo "✅ sent → expect: Arrivée à l'\''étape STATION SOAVA NG PBF"

sleep 2

# ── [4] enroute_depot ─────────────────────────────────────────────────────────
# 4730DJ departs toward DEPOT MAHAJANGA (distance from prev zone → next zone computed via OSRM)
echo ""
echo "--- [4/7] enroute_depot: 4730DJ → DEPOT MAHAJANGA ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 4730DJ a débuté la livraison DEPOT MAHAJANGA. A 2026-04-01 06:38:00 allant à une vitesse de 48 km/h près de '\''Mahajanga, Boeny, Madagascar, 1.2 km from Mahajanga'\''.":""}' \
  && echo "" && echo "✅ sent → expect: Temps restant jusqu'\''à la livraison estimé: HH:MM"

sleep 2

# ── [5] enroute_client ────────────────────────────────────────────────────────
# 4730DJ departs toward STATION ATAFANA PBF (trajet 2, previous zone: DEPOT MAHAJANGA trajet 1)
echo ""
echo "--- [5/7] enroute_client: 4730DJ → STATION ATAFANA PBF ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 4730DJ a débuté la livraison STATION ATAFANA PBF. A 2026-04-01 07:35:00 allant à une vitesse de 55 km/h près de '\''Mahajanga, Boeny, Madagascar, 3.1 km from Atafana'\''.":""}' \
  && echo "" && echo "✅ sent → expect: en cours de route... with Heure d'\''arrivée estimée"

sleep 2

# ── [6] long vehicle name (cut at first dash) ─────────────────────────────────
# "7618AF-RENAULT KWID-GALANA" → resolved as "7618AF"
# 7618AF: Parking DEPOT RAFFINERIE TERMINAL → DEPOT RAFFINERIE TERMINAL → SS BARIKADIMY PBF
echo ""
echo "--- [6/7] long name cut at dash: 7618AF-RENAULT KWID-GALANA → SS BARIKADIMY PBF ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 7618AF-RENAULT KWID-GALANA est arrivé au point de livraison SS BARIKADIMY PBF. A 2026-04-01 09:10:00 à une Vitesse de 30 km/h près de '\''Barikadimy, Toamasina, Atsinanana, Madagascar, 1.0 km from Barikadimy'\''.":""}' \
  && echo "" && echo "✅ sent → expect: Arrivée à l'\''étape SS BARIKADIMY PBF (vehicle resolved as 7618AF)"

sleep 2

# ── [7] enroute_client multi-stop ─────────────────────────────────────────────
# 5282TBA departs toward SS TALATAMATY NG PBF (trajet 3, previous: STATION ANJOMA PBF trajet 2)
echo ""
echo "--- [7/7] enroute_client multi-stop: 5282TBA → SS TALATAMATY NG PBF ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 5282TBA a débuté la livraison SS TALATAMATY NG PBF. A 2026-04-01 09:45:00 allant à une vitesse de 42 km/h près de '\''Talatamaty, Antananarivo, Madagascar, 2.5 km from Talatamaty'\''.":""}' \
  && echo "" && echo "✅ sent → expect: en cours de route... (prev zone: STATION ANJOMA PBF)"

echo ""
echo "========================================================================"
echo " Ignored cases (no destination — should be skipped silently)"
echo "========================================================================"

# ── [8] IGNORED: a débuté la livraison with no destination ───────────────────
echo ""
echo "--- [8] IGNORED: no destination in a débuté la livraison ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 1498TBH a débuté la livraison. A 2026-04-01 07:05:00 allant à une vitesse de 32 km/h près de '\''N 2Bis, Toamasina, Atsinanana, Madagascar'\''.":""}' \
  && echo "" && echo "✅ sent → expect: skipped (no destination)"

sleep 1

# ── [9] IGNORED: est arrivé with no destination ───────────────────────────────
echo ""
echo "--- [9] IGNORED: no destination in est arrivé au point de livraison ---"
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"Le véhicule 3277TBM est arrivé au point de livraison. A 2026-04-01 08:00:00 à une Vitesse de 10 km/h près de '\''Antananarivo, Madagascar'\''.":""}' \
  && echo "" && echo "✅ sent → expect: skipped (no destination)"

echo ""
echo "========================================================================"
echo " All tests sent. Check server logs for results."
echo " All emails → alanic.nguetsa@camtrack.net (from E-mail client column)"
echo "========================================================================"
