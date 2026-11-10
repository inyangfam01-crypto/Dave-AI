#!/bin/bash
# Build-time install: Wine prefix, MetaTrader 5 from the official installer, a first run so the
# terminal unpacks its MQL5 folder (the standard library the EA needs to compile), and hard checks
# that the image can actually show a MetaTrader window.
#
# Why the checks: Wine picks its window driver ("x11") the first time a Wine process starts. If the
# screen is not answering at that moment -- or if the x11 driver is missing a library -- Wine runs
# with no window driver at all, prints "Application tried to create a window, but no driver could be
# loaded", and keeps that for every later Wine process: MetaTrader never appears, MetaEditor hangs on
# compile, MQL5 is never unpacked. An image like that looks fine in Railway and can never trade, so
# this script now fails the build and says which library is missing.
set -e
MT5_DIR="$WINEPREFIX/drive_c/Program Files/MetaTrader 5"
export WINEDEBUG=-all
export DISPLAY=:99
DISP_NUM=99

echo "wine: $("$WINE_BIN" --version)"

# --- a virtual screen that is actually answering ---------------------------------------------------
# The lock/socket of an Xvfb from an earlier layer makes a new Xvfb exit with "Server is already
# active for display 99" and leaves nothing on :99.
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}"
Xvfb ":${DISP_NUM}" -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb-build.log 2>&1 &
XVFB=$!
READY=0
for i in $(seq 1 60); do
  if xdpyinfo -display ":${DISP_NUM}" >/dev/null 2>&1; then READY=1; break; fi
  kill -0 $XVFB 2>/dev/null || break
  sleep 1
done
if [ "$READY" != 1 ]; then
  echo "the virtual screen did not come up -- Xvfb said:"
  cat /tmp/xvfb-build.log 2>/dev/null || true
  exit 1
fi
echo "virtual screen :${DISP_NUM} ready"
xsetroot -solid '#202020' 2>/dev/null || true

# --- can Wine load its window driver? --------------------------------------------------------------
# Wine 9 ships this as winex11.so; older builds call it winex11.drv.so. Look for both.
DRV="$(find /usr/lib -maxdepth 6 \( -name 'winex11.drv.so' -o -name 'winex11.so' \) 2>/dev/null | head -1)"
echo "wine x11 driver: ${DRV:-MISSING}"
if [ -z "$DRV" ]; then
  echo "the x11 window driver is not in this image -- MetaTrader could never open a window"
  exit 1
fi
# Wine's own libraries (ntdll.so, win32u.so, ...) sit beside the driver and are loaded by Wine's
# loader, not by ld.so, so a bare ldd reports them as "not found" on a perfectly good image -- that
# false alarm is what stopped this build. Give ldd every Wine library directory first, and only what
# is still missing after that is really missing.
DRV_DIR="$(dirname "$DRV")"
WINE_LIB_PATH="$DRV_DIR"
for d in /usr/lib/*/wine /usr/lib/*/wine/*-unix /usr/lib/wine /usr/lib/wine/*-unix; do
  [ -d "$d" ] && WINE_LIB_PATH="$WINE_LIB_PATH:$d"
done
MISSING_LIBS="$(LD_LIBRARY_PATH="$WINE_LIB_PATH" ldd "$DRV" 2>/dev/null | grep 'not found' || true)"
if [ -n "$MISSING_LIBS" ]; then
  echo "the x11 window driver cannot load -- these libraries are missing from the image:"
  echo "$MISSING_LIBS"
  exit 1
fi
echo "the x11 window driver loads ($(LD_LIBRARY_PATH="$WINE_LIB_PATH" ldd "$DRV" 2>/dev/null | wc -l) libraries resolved)"

"$WINE_BIN" wineboot --init >/dev/null 2>&1 || true
"$WINE_BIN" reg add "HKEY_CURRENT_USER\\Software\\Wine" /v Version /t REG_SZ /d win10 /f

# --- MetaTrader ------------------------------------------------------------------------------------
curl -fsSL -o /tmp/mt5setup.exe https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
"$WINE_BIN" /tmp/mt5setup.exe /auto || true   # exits non-zero on a harmless 32-bit helper; checked below
rm -f /tmp/mt5setup.exe
test -e "$MT5_DIR/terminal64.exe" || { echo "MT5 did not install"; exit 1; }
echo "MetaTrader 5 installed: $MT5_DIR"

# One bounded first run of MetaTrader itself: the real test that Wine can put a window on the screen,
# and the run that unpacks MQL5.
# +seh: MetaTrader dies on its own ("NtRaiseHardError 50000018") before it writes any log of its
# own, so the exception Wine sees is the only evidence of why. Record it, and look at the window
# while the terminal is still alive instead of after it has gone.
( cd "$MT5_DIR" && WINEDEBUG=+seh "$WINE_BIN" terminal64.exe /portable >/tmp/mt5-first-run.log 2>&1 ) &
WINDOW_OK=0
for i in $(seq 1 60); do
  if [ -n "$(xdotool search --onlyvisible --name '.' 2>/dev/null | head -1)" ]; then WINDOW_OK=1; break; fi
  sleep 2
done
echo "[mt5] window titles while the terminal is up:"
for w in $(xdotool search --onlyvisible --name '.' 2>/dev/null); do
  echo "[mt5]   '$w' = '$(xdotool getwindowname "$w" 2>/dev/null | head -c 120)'"
done
sleep 20
import -display :99 -window root -resize 800x -quality 40 /tmp/shot-early.jpg 2>/dev/null || true
[ -s /tmp/shot-early.jpg ] && base64 -w 800 /tmp/shot-early.jpg | sed 's/^/SHOT30 /'
if [ "$WINDOW_OK" = 1 ]; then
  echo "MetaTrader window is on the screen -- Wine can draw"
else
  echo "META TRADER SHOWED NO WINDOW AFTER 120s -- this image would run blind. Wine said:"
  grep -E "driver could be loaded|DISPLAY|err:" /tmp/mt5-first-run.log 2>/dev/null | head -15 || true
  grep -E "c0000|5000|seh:|Exception|unhandled|page fault" /tmp/mt5-first-run.log 2>/dev/null | head -30 || true
  tail -25 /tmp/mt5-first-run.log 2>/dev/null || true
  xwininfo -root -tree 2>/dev/null | head -10 || true
  pkill -f terminal64.exe || true
  kill $XVFB 2>/dev/null || true
  exit 1
fi

for i in $(seq 1 120); do [ -d "$MT5_DIR/MQL5/Include/Trade" ] && break; sleep 2; done
pkill -f terminal64.exe || true
# wine64-only packages may not put wineserver on PATH (Ubuntu's newer repack does not) -- find it
# the real way and never fail the build here.
WS="$(command -v wineserver 2>/dev/null || true)"
[ -z "$WS" ] && WS="$(ls /usr/lib/wine/wineserver 2>/dev/null | head -1 || true)"
[ -z "$WS" ] && WS="$(find /usr -name wineserver -type f 2>/dev/null | head -1 || true)"
if [ -n "$WS" ]; then timeout 30 "$WS" -w 2>/dev/null || true; fi
kill $XVFB 2>/dev/null || true
rm -f "/tmp/.X${DISP_NUM}-lock" "/tmp/.X11-unix/X${DISP_NUM}"
if [ -d "$MT5_DIR/MQL5/Include/Trade" ]; then
  echo "MQL5 unpacked at build time"
  # The terminal's bundled examples and sounds are not needed and cost image size.
  for d in "MQL5/Experts/Examples" "MQL5/Scripts/Examples" "MQL5/Indicators/Examples" "Sounds" "Tester"; do
    if [ -d "$MT5_DIR/$d" ]; then rm -rf -- "$MT5_DIR/$d"; fi
  done
else
  echo "MQL5 not unpacked at build time -- start.sh finishes it at boot (log below)"
  echo "exception/seh lines:"
  grep -E "c0000|5000|seh:|Exception|unhandled|page fault" /tmp/mt5-first-run.log 2>/dev/null | head -30 || true
  ls -la "$MT5_DIR" 2>/dev/null | head -15 || true
  tail -25 /tmp/mt5-first-run.log 2>/dev/null || true
fi
