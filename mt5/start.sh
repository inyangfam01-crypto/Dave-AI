#!/bin/bash
# Container start: a virtual screen for MetaTrader, then the agent (which starts MT5 once Dave
# sends the account). MetaTrader itself was installed into the image at build time.
mkdir -p "$DAVE_STATE_DIR"

# 24-bit depth: MetaTrader does not come up on a 16-bit screen (that is why a first run under 16-bit
# produced no MQL5 folder), and the screen is what the app relays to the phone.
Xvfb :99 -screen 0 1280x1024x24 >/dev/null 2>&1 &
sleep 2

MT5_DIR="${WINEPREFIX:-/opt/wine}/drive_c/Program Files/MetaTrader 5"
WINE="${WINE_BIN:-/usr/lib/wine/wine64}"

mql5_ready() { [ -d "$MT5_DIR/MQL5/Include/Trade" ]; }

# Everything the next person needs to see when MetaTrader will not come up, printed into the
# service log: what is running, what windows exist on the virtual screen, whether MQL5 appeared
# anywhere in the prefix, what Wine said, and a picture of the screen (base64, one chunk per line,
# marked SHOT) so the exact dialog MetaTrader is stuck on can be read instead of guessed.
diagnose() {
  echo "[diag] ---- ($1) ----"
  echo "[diag] processes:"
  ps -eo pid,etime,args 2>/dev/null | grep -Ei "terminal64|metaeditor|wine|Xvfb" | grep -v grep | head -20
  echo "[diag] windows:"
  for w in $(xdotool search --onlyvisible --name "." 2>/dev/null); do
    echo "[diag] win $w name='$(xdotool getwindowname "$w" 2>/dev/null | head -c 100)' geom=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | tr '\n' ' ')"
  done
  echo "[diag] MQL5 folders in the prefix:"
  find "$WINEPREFIX/drive_c" -maxdepth 8 -type d -name MQL5 2>/dev/null | head -5
  echo "[diag] install dir:"
  ls -la "$MT5_DIR" 2>/dev/null | head -12
  echo "[diag] wine said (last 25):"
  tail -25 /tmp/mt5-first-run.log 2>/dev/null
  echo "[diag] screen:"
  import -display :99 -window root -resize 1100x -quality 60 /tmp/shot.jpg 2>/dev/null
  ls -l /tmp/shot.jpg 2>/dev/null
  base64 -w 900 /tmp/shot.jpg 2>/dev/null | sed 's/^/SHOT /'
  echo "[diag] ---- end ----"
}

# First-boot safety net: the image is meant to already hold the MQL5 folder (install-mt5.sh at build
# time). When it does not, run the terminal here and watch it, because a terminal that starts and
# then sits on a modal window never writes the folder and says nothing about it.
if ! mql5_ready && [ -e "$MT5_DIR/terminal64.exe" ]; then
  echo "[mt5] first run: letting MetaTrader unpack its MQL5 folder"
  ( cd "$MT5_DIR" && WINEDEBUG=err+all "$WINE" terminal64.exe /portable >/tmp/mt5-first-run.log 2>&1 ) &
  for i in $(seq 1 30); do
    mql5_ready && break
    sleep 2
  done
  # A modal box (Wine's own error dialog, a licence/update prompt) blocks start-up forever until its
  # default button is pressed. Press Return on every visible window a few times; harmless on the
  # terminal window itself.
  if ! mql5_ready; then
    echo "[mt5] no MQL5 after 60s -- dismissing any dialog with Return"
    for w in $(xdotool search --onlyvisible --name "." 2>/dev/null); do
      xdotool key --window "$w" --clearmodifiers Return >/dev/null 2>&1
    done
    for i in $(seq 1 45); do
      mql5_ready && break
      sleep 2
    done
  fi
  if mql5_ready; then
    echo "[mt5] MQL5 unpacked"
    pkill -f terminal64.exe || true
    sleep 2
  else
    echo "[mt5] MQL5 still missing -- full report:"
    diagnose "mql5 missing"
  fi
else
  echo "[mt5] MQL5 present in the image"
fi

# The screen, for the app: VNC on localhost only, served to the browser by noVNC on 6080 (reachable
# on Railway's private network only; the bot checks the paired phone before relaying it).
x11vnc -display :99 -rfbport 5900 -localhost -shared -forever -nopw -quiet -noxdamage >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
exec python3 /opt/dave/agent.py
