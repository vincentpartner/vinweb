#!/bin/zsh
# VinWeb-Starter - Doppelklick genuegt.
# Selbstheilend wie VinWebMini.command: prueft nicht nur, OB der Port belegt
# ist, sondern ob der Server wirklich ANTWORTET. Haengende Reste werden
# aufgeraeumt und frisch gestartet. (Der alte blosse Port-Check schlug fehl,
# sobald ein Browser noch offene Verbindungen auf 4400 hielt - dann hiess es
# "laeuft bereits", obwohl gar kein Server mehr da war.)

cd "/Users/retopuma/Downloads/Apps/Webdesign/Vincent Websystem" || {
  echo "VinWeb-Ordner nicht gefunden - wurde er verschoben?"
  read -k1 -s "?Taste druecken zum Schliessen."
  exit 1
}

# Antwortet schon eine gesunde Instanz? Dann nur den Browser oeffnen.
if curl -s --max-time 2 -o /dev/null "http://127.0.0.1:4400/api/projekte"; then
  echo "VinWeb laeuft bereits - oeffne den Browser."
  open "http://127.0.0.1:4400"
  exit 0
fi

# Port belegt, aber keine Antwort? Dann haengt ein alter Rest - aufraeumen.
# Nur LAUSCHENDE Prozesse killen (nie die offenen Verbindungen des Browsers).
reste=$(lsof -ti tcp:4400 -sTCP:LISTEN 2>/dev/null; lsof -ti tcp:4401 -sTCP:LISTEN 2>/dev/null)
if [ -n "$reste" ]; then
  echo "Ein haengender alter Start blockiert die Ports - wird aufgeraeumt."
  echo "$reste" | xargs kill 2>/dev/null
  sleep 1
fi

# Browser oeffnen, sobald der Server bereit ist (im Hintergrund gewartet).
( for i in {1..30}; do
    curl -s -o /dev/null "http://127.0.0.1:4400" && { open "http://127.0.0.1:4400"; exit 0; }
    sleep 0.5
  done ) &

echo ""
echo "  VinWeb startet ... Dieses Fenster offen lassen."
echo "  Beenden: dieses Fenster schliessen oder Ctrl+C druecken."
echo ""
npm start
