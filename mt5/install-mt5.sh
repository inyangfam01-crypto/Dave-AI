#!/bin/bash
# Build-time install: Wine prefix, MetaTrader 5 from the official installer, and one first run so
# the terminal unpacks its MQL5 folder (the standard library the EA needs to compile).
#
# The long wait this used to do is best effort now: Railway's builder gave the terminal ten minutes
# and it never unpacked, and a build that dies on that leaves nothing to debug from. So the image
# always builds with MetaTrader installed, the attempt prints what Wine said, and start.sh finishes
# the unpack at boot, where its progress is visible in the service logs.
set -e
MT5_DIR="$WINEPREFIX/drive_c/Program Files/MetaTrader 5"
export WINEDEBUG=-all
# 24-bit depth: MetaTrader does not come up on a 16-bit screen, which is why the old first run sat
# there silently and never created MQL5.
Xvfb :99 -screen 0 1280x1024x24 >/dev/null 2>&1 &
XVFB=$!
sleep 2
"$WINE_BIN" --version
"$WINE_BIN" wineboot --init >/dev/null 2>&1 || true
"$WINE_BIN" reg add "HKEY_CURRENT_USER\\Software\\Wine" /v Version /t REG_SZ /d win10 /f
curl -fsSL -o /tmp/mt5setup.exe https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
"$WINE_BIN" /tmp/mt5setup.exe /auto || true   # exits non-zero on a harmless 32-bit helper; checked below
rm -f /tmp/mt5setup.exe
test -e "$MT5_DIR/terminal64.exe" || { echo "MT5 did not install"; exit 1; }
echo "MetaTrader 5 installed: $MT5_DIR"
# One bounded first run (4 minutes): unpack MQL5 if this builder is fast enough.
( cd "$MT5_DIR" && "$WINE_BIN" terminal64.exe /portable >/tmp/mt5-first-run.log 2>&1 ) &
for i in $(seq 1 120); do [ -d "$MT5_DIR/MQL5/Include/Trade" ] && break; sleep 2; done
pkill -f terminal64.exe || true
# wine64-only packages may not put wineserver on PATH (Ubuntu's newer repack does not) -- find it
# the real way and never fail the build here.
WS="$(command -v wineserver 2>/dev/null || true)"
[ -z "$WS" ] && WS="$(ls /usr/lib/wine/wineserver 2>/dev/null | head -1 || true)"
[ -z "$WS" ] && WS="$(find /usr -name wineserver -type f 2>/dev/null | head -1 || true)"
if [ -n "$WS" ]; then "$WS" -w 2>/dev/null || true; fi
kill $XVFB 2>/dev/null || true
if [ -d "$MT5_DIR/MQL5/Include/Trade" ]; then
  echo "MQL5 unpacked at build time"
  # The terminal's bundled examples and sounds are not needed and cost image size.
  for d in "MQL5/Experts/Examples" "MQL5/Scripts/Examples" "MQL5/Indicators/Examples" "Sounds" "Tester"; do
    [ -d "$MT5_DIR/$d" ] && rm -rf -- "$MT5_DIR/$d"
  done
else
  echo "MQL5 not unpacked at build time -- start.sh finishes it at boot (log below)"
  ls -la "$MT5_DIR" 2>/dev/null | head -15 || true
  tail -25 /tmp/mt5-first-run.log 2>/dev/null || true
fi
