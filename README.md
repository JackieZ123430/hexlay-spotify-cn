# BMW iDrive 7 (MGU) — Custom Apps Suite

<p align="center">
  <b>A collection of custom applications for BMW iDrive 7 (MGU), rendered at 60 fps directly on the vehicle's GPU.</b>
</p>

<p align="center">
  <img alt="60 fps" src="https://img.shields.io/badge/frame%20rate-60%20fps-2ea44f?style=for-the-badge">
  <img alt="OpenGL ES 2" src="https://img.shields.io/badge/render-OpenGL%20ES%202-1c6dd0?style=for-the-badge">
  <img alt="BMW iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
  <img alt="MGU Store Ready" src="https://img.shields.io/badge/MGU%20Store-Compatible-8957e5?style=for-the-badge">
</p>

---

## Included Apps

| App | ID | Description |
| :--- | :--- | :--- |
| **Spotify** | `spotify` | Native Spotify Connect controller, library and playlist browser with 60 fps equalizer indicators and QR code phone pairing. |
| *(More coming soon)* | | Easily add your own apps under `apps/<id>/`. |

---

## How to Install via MGU Store

To add this repository as a source in [MGU Store](https://github.com/robertnisipeanu/mgu-store):

1. On your iDrive central display, open **Store > Sources > Add source**.
2. Enter this repository:
   ```text
   <your-github-username>/idrive7-custom-apps
   ```
3. Tap **OK**. The Store reads `mgu-repo.json` and lists all apps in this suite.
4. Tap any app to install!

---

## How to Add New Apps to this Repo

Any folder added under `apps/` is automatically discovered by MGU Store:

```
apps/
├── spotify/
│   ├── app.json      # Manifest (ID, title, screens, settings)
│   ├── main.js       # App entry point (drawn at 60 fps via kit/mgu)
│   └── icon.png      # 140x140 transparent tile icon
└── my_new_app/
    ├── app.json
    ├── main.js
    └── icon.png
```

---

## Local Development & Live Emulator

Test and run any app on your computer without a car:

```bash
# Build an app (e.g. spotify)
python3 kit/tools/build.py spotify

# Launch the live emulator at http://localhost:8077
node kit/tools/emu.js spotify
```

* **Mouse click / drag**: Touchscreen input.
* **Mouse wheel / `[` `]`**: Turn iDrive rotary controller knob.
* **`Enter`**: Press iDrive controller knob.
* **Arrow keys**: Push controller up / down / left / right.

---

## Manual Installation via ENET Cable

To flash all apps directly to your car via an OBD-ENET cable:

```bash
# 1. Build and pack the car installer kit
python3 kit/tools/build.py
deploy/make-car-kit.sh

# 2. Push over SSH
HU=root@169.254.34.2 PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```

---

## License

This project is released under the GNU General Public License v3.0 or later.
Not affiliated with or endorsed by BMW AG.
