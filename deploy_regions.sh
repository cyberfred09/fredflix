#!/bin/bash
# ╔═══════════════════════════════════════════════════════════════╗
# ║     FREDFLIX — Despliegue Multi-Región en Fly.io              ║
# ║     3 regiones en plan GRATUITO · Sin tarjeta de crédito      ║
# ╠═══════════════════════════════════════════════════════════════╣
# ║  REQUISITOS:                                                  ║
# ║    curl -L https://fly.io/install.sh | sh                    ║
# ║    flyctl auth signup                                         ║
# ╠═══════════════════════════════════════════════════════════════╣
# ║  USO:                                                         ║
# ║    chmod +x deploy_regions.sh && ./deploy_regions.sh          ║
# ╚═══════════════════════════════════════════════════════════════╝

set -e
APP="fredflix-proxy"

# ──────────────────────────────────────────────────
# REGIONES DISPONIBLES EN FLY.IO (plan gratuito: 3)
# ──────────────────────────────────────────────────
# Elige 3 según tus necesidades de geo-bypass:
#
# EUROPA:
#   fra = Frankfurt, Alemania   ← canales DE, AT, CH, EU
#   ams = Amsterdam             ← canales NL, BE
#   mad = Madrid                ← canales ES, PT
#   lhr = Londres               ← canales UK, IE
#   cdg = París                 ← canales FR
#   waw = Varsovia              ← canales PL, CZ, SK
#
# NORTEAMÉRICA:
#   iad = Virginia (US East)    ← canales US East, CA
#   ord = Chicago (US Central)  ← canales US Central
#   lax = Los Ángeles (US West) ← canales US West, MX
#   mia = Miami                 ← canales US Sur, MX
#
# LATINOAMÉRICA:
#   gru = São Paulo             ← canales BR, AR, CL, CO
#   scl = Santiago              ← canales CL, AR
#   bog = Bogotá                ← canales CO, VE, PE
#
# ASIA-PACÍFICO:
#   nrt = Tokio                 ← canales JP, KR
#   sin = Singapur              ← canales SG, MY, TH, ID
#   hkg = Hong Kong             ← canales CN, HK, TW
#   syd = Sídney                ← canales AU, NZ
#   bom = Mumbai                ← canales IN
#
# ORIENTE MEDIO / ÁFRICA:
#   dxb = Dubai                 ← canales AE, SA, EG
#   jnb = Johannesburgo         ← canales ZA, NG

# ── SELECCIÓN ACTUAL (modifica según tus necesidades) ──
REGIONS=("fra" "iad" "sin")
# fra = Europa   │   iad = Norteamérica   │   sin = Asia

# ──────────────────────────────────────────────────

echo "╔══════════════════════════════════════════╗"
echo "║      FREDFLIX Multi-Región Deploy         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Crear la app (solo la primera vez)
create_app() {
  echo "→ Creando app $APP..."
  flyctl apps create "$APP" --machines 2>/dev/null || echo "  (app ya existe)"
}

# Crear fly.toml para el proxy Flask
create_toml() {
  cat > fly.toml << 'TOML'
app = "fredflix-proxy"
primary_region = "fra"

[build]
  dockerfile = "Dockerfile.proxy"

[env]
  PORT = "8765"
  LOG_LEVEL = "WARNING"

[[services]]
  protocol = "tcp"
  internal_port = 8765

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [services.concurrency]
    type = "requests"
    hard_limit = 200
    soft_limit = 100

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
TOML
  echo "→ fly.toml creado"
}

# Crear Dockerfile para el proxy
create_dockerfile() {
  cat > Dockerfile.proxy << 'DOCKER'
FROM python:3.12-slim
WORKDIR /app
RUN pip install flask requests gunicorn --no-cache-dir
COPY fredflix_proxy.py .
EXPOSE 8765
CMD ["gunicorn", "-w", "2", "-b", "0.0.0.0:8765", "--timeout", "60", "fredflix_proxy:app"]
DOCKER
  echo "→ Dockerfile.proxy creado"
}

# Desplegar en una región
deploy_region() {
  local REGION=$1
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Desplegando en: $REGION"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  flyctl deploy \
    --app "$APP" \
    --region "$REGION" \
    --strategy immediate \
    --no-cache \
    2>&1 | tail -20
  echo "  ✓ Desplegado en $REGION"
  echo "  URL: https://${APP}.fly.dev (desde $REGION)"
}

# Main
create_app
create_toml
create_dockerfile

for region in "${REGIONS[@]}"; do
  deploy_region "$region"
done

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                  DESPLIEGUE COMPLETADO                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Para despliegues multi-instancia (una URL por región):      ║"
echo "║                                                               ║"
echo "║  1. Crea una app separada por región:                         ║"
echo "║     flyctl apps create fredflix-proxy-eu                     ║"
echo "║     flyctl apps create fredflix-proxy-us                     ║"
echo "║     flyctl apps create fredflix-proxy-as                     ║"
echo "║                                                               ║"
echo "║  2. Despliega cada una:                                       ║"
echo "║     flyctl deploy --app fredflix-proxy-eu --region fra       ║"
echo "║     flyctl deploy --app fredflix-proxy-us --region iad       ║"
echo "║     flyctl deploy --app fredflix-proxy-as --region sin       ║"
echo "║                                                               ║"
echo "║  3. En Fredflix Ajustes:                                      ║"
echo "║     Europa:      https://fredflix-proxy-eu.fly.dev            ║"
echo "║     América:     https://fredflix-proxy-us.fly.dev            ║"
echo "║     Asia:        https://fredflix-proxy-as.fly.dev            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
