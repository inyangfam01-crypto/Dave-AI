#!/bin/bash
# Container start: a virtual screen that is genuinely answering, then the agent (which starts MT5
# once Dave sends the account). MetaTrader itself was installed into the image at build time.
#
# Order matters more than it looks: Wine picks its window driver the first time any Wine process
# runs. Starting Wine while :99 is still coming up makes every later Wine process in this container
# windowless ("no driver could be loaded") -- no MT5 window, no MetaEditor, no MQL5. So the screen is
# verified with xdpyinfo before anything under Wine is touched, and a stale wineserver is dropped.
mkdir -p "$DAVE_STATE_DIR"

DISP_NUM="${DISPLAY#:}"
DISP_NUM="${DISP_NUM%%.*}"
DISPLAY=":${DISP_NUM}"
export DISPLAY
echo "[mt5] starting the virtual screen on ${DISPLAY}"
pkill -f "Xvfb ${DISPLAY}" 2>/dev/null || true
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}"
Xvfb "${DISPLAY}" -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 60); do
  xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
  sleep 1
done
if ! xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
  echo "[mt5] the virtual screen did not come up -- Xvfb said:"
  cat /tmp/xvfb.log 2>/dev/null | tail -20
  echo "[mt5] MetaTrader cannot run without a screen; the agent will report it as down"
else
  echo "[mt5] virtual screen ready"
  xsetroot -solid '#202020' 2>/dev/null || true
fi

# Drop a wineserver left over from a run that started without a screen: it would keep the null
# window driver for every Wine process that reuses it.
WS="$(command -v wineserver 2>/dev/null || true)"
[ -z "$WS" ] && WS="$(ls /usr/lib/wine/wineserver 2>/dev/null | head -1 || true)"
if [ -n "$WS" ]; then "$WS" -k 2>/dev/null || true; fi

MT5_DIR="${WINEPREFIX:-/opt/wine}/drive_c/Program Files/MetaTrader 5"
WINE="${WINE_BIN:-/usr/lib/wine/wine64}"

mql5_ready() { [ -d "$MT5_DIR/MQL5/Include/Trade" ]; }


# Read whatever MetaTrader is showing instead of guessing: the dialog that blocks start-up is drawn
# on the virtual screen, so photograph it and run OCR over the picture. Printed between markers so
# the text can be lifted straight out of the CI/Railway log.
shoot_and_read() {
  local tag="$1"
  import -display "${DISPLAY}" -window root -resize 900x -quality 45 "/tmp/shot-${tag}.jpg" 2>/dev/null || return 0
  echo "[ocr] ---- screen ${tag} ----"
  command -v tesseract >/dev/null 2>&1 && tesseract "/tmp/shot-${tag}.jpg" - 2>/dev/null | sed '/^$/d' | head -25
  echo "[ocr] ---- end ${tag} ----"
  base64 -w 900 "/tmp/shot-${tag}.jpg" 2>/dev/null | sed "s/^/SHOT-${tag} /"
}

# Everything the next person needs to see when MetaTrader will not come up, printed into the
# service log: what is running, what windows exist on the virtual screen, whether MQL5 appeared
# anywhere in the prefix, what Wine said, and a picture of the screen (base64, one chunk per line,
# marked SHOT) so the exact dialog MetaTrader is stuck on can be read instead of guessed.
diagnose() {
  echo "[diag] ---- ($1) ----"
  echo "[diag] display: $(xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && echo answering || echo DEAD)"
  echo "[diag] processes:"
  ps -eo pid,etime,args 2>/dev/null | grep -Ei "terminal64|metaeditor|wine|Xvfb" | grep -v grep | head -20
  echo "[diag] windows:"
  for w in $(xdotool search --onlyvisible --name "." 2>/dev/null); do
    echo "[diag] win $w name='$(xdotool getwindowname "$w" 2>/dev/null | head -c 100)' geom=$(xdotool getwindowgeometry --shell "$w" 2>/dev/null | tr '\n' ' ')"
  done
  echo "[diag] window tree:"
  xwininfo -root -tree 2>/dev/null | head -25
  echo "[diag] active window: '$(xdotool getactivewindow getwindowname 2>/dev/null | head -c 100)'"
  echo "[diag] MQL5 folders in the prefix:"
  find "$WINEPREFIX/drive_c" -maxdepth 8 -type d -name MQL5 2>/dev/null | head -5
  echo "[diag] MQL5 contents:"
  ls -la "$MT5_DIR/MQL5" 2>/dev/null | head -20
  echo "[diag] install dir:"
  ls -la "$MT5_DIR" 2>/dev/null | head -12
  echo "[diag] wine said (last 25):"
  tail -25 /tmp/mt5-first-run.log 2>/dev/null
  echo "[diag] screen:"
  import -display "${DISPLAY}" -window root -resize 900x -quality 45 /tmp/shot.jpg 2>/dev/null
  ls -l /tmp/shot.jpg 2>/dev/null
  base64 -w 900 /tmp/shot.jpg 2>/dev/null | sed 's/^/SHOT /'
  shoot_and_read "end"
  echo "[diag] ---- end ----"
}

# First-boot safety net: the image is meant to already hold the MQL5 folder (install-mt5.sh at build
# time). When it does not, run the terminal here and watch it, because a terminal that starts and
# then sits on a modal window never writes the folder and says nothing about it.
if ! mql5_ready && [ -e "$MT5_DIR/terminal64.exe" ]; then
  echo "[mt5] first run: letting MetaTrader unpack its MQL5 folder"
  ( cd "$MT5_DIR" && WINEDEBUG=err+all,msgbox "$WINE" terminal64.exe /portable >/tmp/mt5-first-run.log 2>&1 ) &
  for i in $(seq 1 60); do
    mql5_ready && break
    if [ $((i % 15)) -eq 0 ]; then
      echo "[mt5] still unpacking ($((i * 2))s) -- windows: $(xdotool search --onlyvisible --name '.' 2>/dev/null | wc -l)"
      for w in $(xdotool search --onlyvisible --name "." 2>/dev/null); do
        echo "[mt5]   win $w='$(xdotool getwindowname "$w" 2>/dev/null | head -c 100)'"
      done
      [ $i -eq 30 ] && shoot_and_read "60s"
    fi
    sleep 2
  done
  # A modal box (Wine's own error dialog, a licence/update prompt) blocks start-up forever until its
  # default button is pressed. Press Return on every visible window a few times; harmless on the
  # terminal window itself.
  if ! mql5_ready; then
    echo "[mt5] no MQL5 after 120s -- dismissing any dialog with Return"
    for round in 1 2 3; do
      for w in $(xdotool search --onlyvisible --name "." 2>/dev/null); do
        xdotool key --window "$w" --clearmodifiers Return >/dev/null 2>&1
      done
      for i in $(seq 1 20); do mql5_ready && break; sleep 2; done
      mql5_ready && break
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
x11vnc -display "${DISPLAY}" -rfbport 5900 -localhost -shared -forever -nopw -quiet -noxdamage >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
exec python3 /opt/dave/agent.py
