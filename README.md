# BMW iDrive 7 (MGU) — Native Spotify App

<p align="center">
  <b>Native Spotify Connect player and library browser for BMW iDrive 7 (MGU), rendered at 60 fps on the vehicle's GPU.</b>
</p>

<p align="center">
  <img alt="60 fps" src="https://img.shields.io/badge/frame%20rate-60%20fps-2ea44f?style=for-the-badge">
  <img alt="OpenGL ES 2" src="https://img.shields.io/badge/render-OpenGL%20ES%202-1c6dd0?style=for-the-badge">
  <img alt="BMW iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
  <img alt="Spotify Connect" src="https://img.shields.io/badge/Spotify-Connect-1ed760?style=for-the-badge">
</p>

---

## Overview

This app runs directly on BMW's **Media Graphic Unit (MGU / Head Unit High 3)** running iDrive 7. 

Designed specifically for automotive cockpits:
* **Cockpit Ergonomics**: Seamlessly blends BMW G20 / G15 Live Cockpit dark styling with Spotify green accents.
* **Controller & Touch**: Fully navigable using both the physical **iDrive rotary controller (FrontCCU)** and the central touchscreen.
* **True 60 FPS GPU Rendering**: Drawn directly on the compositor layer via `mgu-render` using OpenGL ES 2 vector commands.
* **Seamless Audio**: Your phone streams audio through your car's stereo (Bluetooth or CarPlay), while this app gives you full library browsing and playlist switching on the main screen.

---

## How to Install via MGU Store

If you have [MGU Store](https://github.com/robertnisipeanu/mgu-store) installed on your head unit:

1. On the central display, open **Store > Sources > Add source**.
2. Type this repository's GitHub path:
   ```text
   <your-github-username>/idrive7-spotify
   ```
3. Tap **OK**. The Store reads `mgu-repo.json` and lists **Spotify**.
4. Tap **Install**. The tile appears under **CAR > Installed Apps > Spotify**!

---

## Features

* **Playlists View**: Split-pane view of all your playlists with song counts, descriptions, and M-color accents.
* **Live In-List Playing Indicator**: The track currently streaming to your car lights up with a glowing green border and an **animated 4-bar equalizer** bouncing at 60 fps.
* **Your Library**: Quick one-tap cards for Liked Songs (Favorites), Heavy Rotation, Saved Albums, and Following Artists.
* **Queue**: Real-time view of upcoming tracks.
* **Easy Phone Pairing**: On-screen QR code lets any driver or passenger scan with their phone camera and connect in seconds.
* **Device Switcher**: Switch playback between your phone, car, or other Spotify Connect devices with one tap.

---

## Local Development & Live Emulator

You can test and run the app right on your computer without a car or VM:

```bash
# 1. Build the package
python3 kit/tools/build.py spotify

# 2. Start the live 60 fps emulator
node kit/tools/emu.js spotify
```

Then open **`http://localhost:8077`** in your browser.

* **Mouse click / drag**: Touchscreen input.
* **Mouse wheel / `[` `]`**: Turn iDrive rotary controller knob.
* **`Enter`**: Press iDrive controller knob.
* **Arrow keys**: Push controller up / down / left / right.

### Connecting Real Spotify in Emulator

To connect your live Spotify account to the emulator:
```bash
# Authenticate via browser
node apps/spotify/auth.js --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>

# Or with a temporary token
node apps/spotify/auth.js --token "BQC..."
```

---

## Manual Installation via ENET Cable

To deploy directly to your vehicle over an OBD-ENET cable:

```bash
# 1. Build and pack the car installer kit
python3 kit/tools/build.py spotify
deploy/make-car-kit.sh

# 2. Push over SSH (replace with your unit IP and enrolled key)
HU=root@169.254.34.2 PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```

---

## License

This project is released under the GNU General Public License v3.0 or later.
Not affiliated with or endorsed by BMW AG or Spotify AB.
