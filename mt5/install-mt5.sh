#!/bin/bash
# Build-time install: Wine prefix, MetaTrader 5 from the official installer, and one first run so
# the terminal unpacks its MQL5 folder (the standard library the EA needs to compile).
set -e
MT5_DIR="$WINEPREFIX/drive_c/Program Files/MetaTrader 5"
Xvfb :99 -screen 0 1024x768x16 >/dev/null 2>&1 &
XVFB=$!
sleep 2
"$WINE_BIN" --version
"$WINE_BIN" wineboot --init
"$WINE_BIN" reg add "HKEY_CURRENT_USER\\Software\\Wine" /v Version /t REG_SZ /d win10 /f
curl -fsSL -o /tmp/mt5setup.exe https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
"$WINE_BIN" /tmp/mt5setup.exe /auto || true   # exits non-zero on a harmless 32-bit helper; checked below
rm -f /tmp/mt5setup.exe
test -e "$MT5_DIR/terminal64.exe" || { echo "MT5 did not install"; exit 1; }
(cd "$MT5_DIR" && "$WINE_BIN" terminal64.exe /portable) &
# First-run unpack can take well past three minutes on busy builders (observed on a day when even
# the apt layer took 354s: 240s was not enough and the check below killed the build) -- cap at ten
# minutes, break the instant the folder exists.
for i in $(seq 1 300); do [ -d "$MT5_DIR/MQL5/Include/Trade" ] && break; sleep 2; done
sleep 5
pkill -f terminal64.exe || true
# wine64-only packages may not put wineserver on PATH (Ubuntu's newer repack doesn't) -- find it the
# real way, fall back to the loader's sibling and a filesystem search, and never fail the build here.
WS="$(command -v wineserver 2>/dev/null || true)"
[ -z "$WS" ] && WS="$(ls /usr/lib/wine/wineserver 2>/dev/null | head -1 || true)"
[ -z "$WS" ] && WS="$(find /usr -name wineserver -type f 2>/dev/null | head -1 || true)"
if [ -n "$WS" ]; then "$WS" -w 2>/dev/null || true; fi
kill $XVFB || true
test -d "$MT5_DIR/MQL5/Include/Trade" || { echo "MT5 did not unpack MQL5"; exit 1; }
# The terminal's bundled examples and sounds are not needed and cost image size.
rm -rf "$MT5_DIR/MQL5/Experts/Examples" "$MT5_DIR/MQL5/Scripts/Examples" "$MT5_DIR/MQL5/Indicators/Examples" "$MT5_DIR/Sounds" "$MT5_DIR/Tester" 2>/dev/null || true
echo "MetaTrader 5 installed"
