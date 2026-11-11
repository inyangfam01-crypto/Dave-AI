# Dave's MT5 container -- the lean build (the default).
#
# MetaTrader 5 under Wine on a virtual screen (Xvfb), with the Dave EA and the agent Dave talks to.
# No desktop: it fits Railway's trial/free limits (1 GB RAM, 0.5 GB volume). MetaTrader is installed
# INTO THE IMAGE at build time, so the volume only has to hold the login settings (a few KB).
# Want to watch MT5 in a browser? Use Dockerfile.desktop instead (needs more memory).
#
# Build context: the repo root. On Railway: RAILWAY_DOCKERFILE_PATH=mt5/Dockerfile.
# The base and Wine are the exact combination MetaTrader was run and verified on: Ubuntu 24.04's own
# 64-bit Wine 9 (installer, EA compile, start-up config, EA loaded). WineHQ's Wine 11 failed to even
# start inside the image build ("could not load kernel32.dll"), so it is not used.
FROM ubuntu:24.04

ENV WINEPREFIX=/opt/wine \
    WINEDEBUG=-all \
    WINEARCH=win64 \
    WINE_BIN=/usr/lib/wine/wine64 \
    DISPLAY=:99 \
    AGENT_PORT=8081 \
    DAVE_STATE_DIR=/data/dave \
    DAVE_EA_SOURCE=/opt/dave/DaveEA.mq5 \
    DEBIAN_FRONTEND=noninteractive \
    LIBGL_ALWAYS_SOFTWARE=1

# wine64 plus the libraries it only "recommends" but MetaTrader needs: TLS (gnutls) for the broker
# and the installer's downloads, and the X/GL bits for its window on the virtual screen.
#
# The libxkbcommon / libxcb / freetype block is not cosmetic: Wine's x11 driver is the ONLY way it
# can open a window, and with --no-install-recommends Ubuntu's wine64 does not pull those in. When
# one is missing Wine says "Application tried to create a window, but no driver could be loaded",
# runs blind, and MetaTrader never appears -- which is exactly what this image was doing.
# x11-utils gives xdpyinfo and x11-xserver-utils gives xsetroot: start.sh uses them to prove the
# screen answers BEFORE any Wine process starts (Wine caches its window driver per container).
# x11vnc + noVNC: the screen, live with mouse and keyboard, relayed to the app by the bot (private
# network only -- see packages/dave-agent-loop/src/mt5-screen.ts).
# xdotool/xwd/imagemagick: the agent enters the MetaQuotes ID in MT5's own Options window (the only
# way MT5 accepts it -- see apply_metaquotes_ids in agent.py) and checks the tick box on screen.
# -qq and Use-Pty=0 keep the build log readable: the apt chatter alone was filling Railway's
# 1000-line build log and pushing the real failure (and install-mt5.sh's report) out of it.
RUN apt-get -qq update \
    && apt-get -qq -y -o Dpkg::Use-Pty=0 install --no-install-recommends ca-certificates curl python3 procps xvfb xauth \
       wine64 libgnutls30t64 libgl1 libgl1-mesa-dri libvulkan1 libdbus-1-3 libcups2t64 libgssapi-krb5-2 libkrb5-3 \
       libxcomposite1 libxcursor1 libxfixes3 libxi6 libxinerama1 libxrandr2 libxrender1 libxxf86vm1 fonts-liberation fonts-dejavu-core fonts-freefont-ttf fonts-noto-core fonts-wine \
       libxkbcommon0 libxkbcommon-x11-0 libfreetype6 libfontconfig1 libx11-xcb1 libxcb1 libxcb-render0 libxcb-shm0 \
       libxcb-util1 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-sync1 \
       libxcb-xfixes0 libxcb-xinerama0 libxcb-xkb1 libxcb-icccm4 libxcb-xrm0 libxcb-xtest0 \
       xdotool x11-apps x11-utils x11-xserver-utils imagemagick tesseract-ocr cabextract winetricks \
       x11vnc novnc python3-websockify \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY mt5/agent.py mt5/start.sh mt5/install-mt5.sh /opt/dave/
COPY ea/DaveEA.mq5 /opt/dave/DaveEA.mq5
COPY ea/versions/ /opt/dave/ea-versions/
RUN chmod +x /opt/dave/*.sh && /opt/dave/install-mt5.sh

EXPOSE 8081 6080
CMD ["/opt/dave/start.sh"]
