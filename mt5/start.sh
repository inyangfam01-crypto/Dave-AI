#!/bin/bash
# Container start: a virtual screen for MetaTrader, then the agent (which starts MT5 once Dave
# sends the account). MetaTrader itself was installed into the image at build time.
mkdir -p "$DAVE_STATE_DIR"
# 24-bit depth: MetaTrader does not come up on a 16-bit screen (that is why a first run under 16-bit
# produced no MQL5 folder), and the screen is what the app relays to the phone.
Xvfb :99 -screen 0 1280x1024x24 >/dev/null 2>&1 &
sleep 2

# First-boot safety net: the image is meant to already hold the MQL5 folder (install-mt5.sh at build
# time). If the builder was too slow for that, let the terminal unpack it here, once, with progress
# in the logs instead of silence -- the agent's EA compile needs MQL5/Include/Trade to exist.
MT5_DIR="${WINEPREFIX:-/opt/wine}/drive_c/Program Files/MetaTrader 5"
WINE="${WINE_BIN:-/usr/lib/wine/wine64}"
if [ ! -d "$MT5_DIR/MQL5/Include/Trade" ] && [ -e "$MT5_DIR/terminal64.exe" ]; then
  echo "[mt5] first run: letting MetaTrader unpack its MQL5 folder"
  ( cd "$MT5_DIR" && "$WINE" terminal64.exe /portable >/tmp/mt5-first-run.log 2>&1 ) &
  for i in $(seq 1 300); do
    [ -d "$MT5_DIR/MQL5/Include/Trade" ] && break
    if [ $((i % 15)) -eq 0 ]; then echo "[mt5] still unpacking (${i}0s)"; fi
    sleep 2
  done
  if [ -d "$MT5_DIR/MQL5/Include/Trade" ]; then
    echo "[mt5] MQL5 unpacked"
    pkill -f terminal64.exe || true
  else
    echo "[mt5] MQL5 still missing after the first run -- terminal log:"
    tail -30 /tmp/mt5-first-run.log 2>/dev/null
  fi
else
  echo "[mt5] MQL5 present in the image"
fi

# The screen, for the app: VNC on localhost only, served to the browser by noVNC on 6080 (reachable
# on Railway's private network only; the bot checks the paired phone before relaying it).
x11vnc -display :99 -rfbport 5900 -localhost -shared -forever -nopw -quiet -noxdamage >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
exec python3 /opt/dave/agent.py
