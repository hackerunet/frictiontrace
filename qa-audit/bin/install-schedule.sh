#!/bin/bash
#
# install-schedule.sh — Registers (or removes) the three-a-day pipeline with launchd.
#
# Kept separate from the pipeline itself because installing it is a decision, not a
# step: once loaded, this hits production storefronts unattended three times a day.
#
#   bash bin/install-schedule.sh install
#   bash bin/install-schedule.sh uninstall
#   bash bin/install-schedule.sh status
#   bash bin/install-schedule.sh crontab    # print an equivalent crontab line instead
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.walmart.qa-audit"
TEMPLATE="$PROJECT_DIR/bin/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${QA_NODE_BIN:-$(command -v node)}"

case "${1:-}" in
  install)
    echo "Instalando agente launchd:"
    echo "   proyecto : $PROJECT_DIR"
    echo "   node     : $NODE_BIN"
    echo "   horario  : $("$NODE_BIN" -e 'console.log(((require("'"$PROJECT_DIR"'/config/pipeline.json").schedule||{}).times||[]).join(", "))') (hora local)"
    echo ""
    echo "⚠ Cada ejecución abre sesión y agrega UN producto al carrito en las 13 tiendas"
    echo "  de producción. Tres al día son 39 inicios de sesión y 39 carritos diarios"
    echo "  sobre la cuenta de prueba. La compra nunca se confirma."
    echo ""
    if [ "${2:-}" != "--yes" ]; then
      read -r -p "¿Continuar? [s/N] " ok
      [[ "$ok" =~ ^[sSyY]$ ]] || { echo "Cancelado."; exit 1; }
    fi

    mkdir -p "$HOME/Library/LaunchAgents"
    # The schedule is generated from config/pipeline.json so there is one place to
    # change it — editing the plist by hand would drift from what the docs claim.
    CAL=$("$NODE_BIN" -e '
      const t=(require("'"$PROJECT_DIR"'/config/pipeline.json").schedule||{}).times||["08:00","15:00","20:00"];
      console.log("  <array>");
      for (const x of t) { const [h,m]=x.split(":").map(Number);
        console.log(`    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`); }
      console.log("  </array>");
    ')
    printf %s "$CAL" > /tmp/qa-cal.$
    sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" -e "s|__NODE_BIN__|$NODE_BIN|g" \
        -e "/__CALENDAR__/r /tmp/qa-cal.$" -e "/__CALENDAR__/d" \
      "$TEMPLATE" > "$TARGET"
    rm -f /tmp/qa-cal.$
    launchctl unload "$TARGET" 2>/dev/null || true
    launchctl load "$TARGET"
    echo "✔ Cargado. Verificá con: launchctl list | grep $LABEL"
    ;;

  uninstall)
    launchctl unload "$TARGET" 2>/dev/null || true
    rm -f "$TARGET"
    echo "✔ Agente removido."
    ;;

  status)
    # Agent state and last-run state are separate questions. Reporting only the first
    # meant that with no agent loaded the command said nothing about the pipeline —
    # which had in fact run three times that day.
    if launchctl list | grep -q "$LABEL"; then
      echo "Agente: CARGADO"
      launchctl list | grep "$LABEL"
      "$NODE_BIN" -e "
        const t=(require('$PROJECT_DIR/config/pipeline.json').schedule||{}).times||[];
        console.log('  horario:', t.join(', '), '(hora local)');
      " 2>/dev/null
    else
      echo "Agente: NO CARGADO  ·  instalar con: bash bin/install-schedule.sh install"
    fi

    echo ""
    echo "Última ejecución del pipeline:"
    "$NODE_BIN" -e "
      const s=require('$PROJECT_DIR/reports/run-status.json');
      console.log('  corrida', s.runId, '·', s.complete?(s.ok?'OK':'CON FALLOS'):'EN CURSO', '·', (s.durationMs/60000).toFixed(1)+' min');
      console.log('  terminada', s.finishedAt||'—');
      for (const st of s.steps) console.log('   ', st.skipped?'⊘':(st.ok?'✓':'✗'), st.id, st.error||'');
    " 2>/dev/null || echo "  (todavía sin reports/run-status.json)"

    echo ""
    echo "Corridas de hoy:"
    "$NODE_BIN" -e "
      const P=require('$PROJECT_DIR/lib/paths');
      const hoy=new Date().toISOString().slice(0,10).replace(/-/g,'');
      const r=P.listRuns().filter(x=>x.ymd===hoy);
      if(!r.length) console.log('  ninguna');
      for(const x of r) console.log('  ', x.id, x.time||'');
    " 2>/dev/null || true
    ;;

  crontab)
    echo "# Pipeline QA Walmart CAM — tres veces al día."
    echo "# Añadir con: crontab -e"
    echo "# launchd (bin/install-schedule.sh install) es preferible en macOS: cron pierde"
    echo "# la ejecución si la máquina está dormida a esa hora, launchd la recupera al despertar."
    echo "0 8,15,20 * * * /bin/bash $PROJECT_DIR/bin/cron-run.sh"
    ;;

  *)
    echo "Uso: bash bin/install-schedule.sh {install|uninstall|status|crontab}"
    exit 1
    ;;
esac
