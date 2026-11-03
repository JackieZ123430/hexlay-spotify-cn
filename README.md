# BMW iDrive 7 (MGU) — Custom Apps Suite

<p align="center">
  <b>A production collection of custom applications for BMW iDrive 7 (MGU High / Intel Atom A3960), rendered at 60 fps directly on the vehicle's GPU.</b>
</p>

<p align="center">
  <img alt="60 fps" src="https://img.shields.io/badge/frame%20rate-60%20fps-2ea44f?style=for-the-badge">
  <img alt="OpenGL ES 2" src="https://img.shields.io/badge/render-OpenGL%20ES%202-1c6dd0?style=for-the-badge">
  <img alt="BMW iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
  <img alt="MGU Store Ready" src="https://img.shields.io/badge/MGU%20Store-Compatible-8957e5?style=for-the-badge">
  <img alt="BDC Safe" src="https://img.shields.io/badge/Safety-BDC%20Isolated-success?style=for-the-badge">
</p>

---

## Included Applications

| App | ID | Category | Highlights |
| :--- | :--- | :--- | :--- |
| **QuickCode** | `quick_code` | Vehicle Coding & Comfort | Safe 1-tap cockpit coding with automated backups for BMW G-Series. Restricted strictly to BDC (`0x40`) with zero head unit black-screen risk. |
| **Spotify** | `spotify` | Media & Entertainment | Native Spotify Connect controller & playlist browser with zero-terminal in-car phone QR pairing, auto token refresh, and 60 fps mini equalizers. |
| **M-Cinema** | `m_cinema` | Video & Casting | In-car cinema & video receiver with phone casting. Enforces Intel Atom A3960 thermal protection (720p/1080p quality clamping). |
| **M-Copilot** | `m_copilot` | Performance Telemetry | Real-time cockpit performance telemetry, lap monitoring, and telemetry logging for BMW M & G-Series vehicles. |

---

## App Deep Dive

### 1. QuickCode (`quick_code`)
One-tap cockpit coding for all BMW G-Series vehicles (G20, G22, G30, G11, G15, G01, G05, etc.):

* **Strict Low-Risk BDC Architecture (`0x40`)**:
  - All coding write operations strictly target **BDC_BODY3 (Body Domain Controller, `0x40`)**.
  - High-risk modules (**HU_MGU `0x63`**, **DME `0x12`**, **DSC `0x29`**) are completely excluded from coding writes.
  - Eliminates any possibility of head unit black-screens, bootloops, or OS crashes.
* **Curated Low-Risk Comfort & Lighting Parameters**:
  - **Auto Start/Stop Memory (`TC_MSA_MEMORY`)**: Remembers the last state across ignition cycles (stays OFF).
  - **Instant Mirror Fold on Lock (`KOMFORT_SCHLIESSEN`)**: Immediate fold upon locking (`0.0s` vs factory `1.5s` delay).
  - **Continuous Window Roll-Up (`FH_TUERAUF_STOP_MAUT`)**: Windows continue rolling up uninterrupted when a door opens.
  - **One-Touch Tailgate Close (`HK_TASTE_TIPP_SCHLIESSEN`)**: 1-touch close tailgate from key fob and driver door button without holding.
  - **5-Flash Comfort Turn Signals (`PIA_DEFAULT_TIPPBLINKEN`)**: One-touch tap flashes 5 times instead of factory 3 flashes.
  - **Curb Monitor Mirror Tilt 70% (`ASP_BORDSTEIN_AUTOMATIK`)**: Passenger mirror dips 70% in reverse to show the curb and rim instead of pointing straight down at the ground.
  - **Acoustic Lock/Unlock Chirp (`DEF_GLOBAL_LOCK_CLO`)**: Audible horn chirp confirmation on lock/unlock.
  - **Emergency Flashing Brake Lights (`BFD_ON`)**: Brake Force Display flashes outer brake lamps under heavy deceleration.
  - **Ambient RGB Color Palettes**: Presets for BMW Bronze (OEM), M Neon Cyan, Miami Violet, Acid Lime, BMW Blue (OEM), and M Crimson Red with live interior light tube preview.
* **Automated Pre-Coding Backups & Rollback**:
  - Captures an automated timestamped snapshot before every parameter modification.
  - Dedicated **"Backups & Rollback"** tab showing historical snapshots with 1-tap `[RESTORE]` rollback.
  - `[RESTORE ALL FACTORY OEM DEFAULTS]` button to revert all parameters back to factory BMW stock.
* **Vehicle Safety Interlocks**:
  - **Motion Safeguard**: Coding is strictly locked if vehicle speed > 0 km/h.
  - **Engine Running Safeguard**: Coding is strictly locked if engine RPM > 0.
  - **Diagnostic Mode Requirement**: Enforces Terminal 15 Diagnostic Mode (3-press Start/Stop, engine off) matching BimmerCode and ISTA safety protocols.

---

### 2. Spotify (`spotify`)
Native Spotify Connect controller and library browser directly on your cockpit display:

* **Zero-Terminal In-Car QR Code Pairing**:
  - The head unit runs a lightweight background authentication server on port `8888`.
  - Connect your phone to the car's Wi-Fi hotspot or Wireless CarPlay and scan the QR code on the **"Connect"** tab.
  - A mobile web page opens: tap **"Connect with Spotify"**, approve on Spotify, and your car screen instantly loads your personal playlists, saved songs, and devices.
  - **No terminal, no SSH, and no Node commands needed.**
* **Automatic Background Token Refresh**:
  - Handles token expiration automatically in the background using stored refresh tokens across ignition cycles.
* **1-Tap Disconnect / Switch Account**:
  - Tapping `[DISCONNECT / SWITCH ACCOUNT]` wipes the active session with one touch so passengers or new drivers can pair their accounts.
* **Cockpit Interface**:
  - 60 fps animated mini equalizers on active tracks.
  - Browse personal playlists, saved library, and queue.
  - Instant device switching across Spotify Connect targets.

---

### 3. M-Cinema (`m_cinema`)
In-car cinema and video receiver for passengers and parked entertainment:

* **Phone-to-Car Video Casting**:
  - Background receiver server on port `8090`.
  - Scan the cockpit QR code to cast YouTube, web videos, or local media directly to the central screen.
* **Intel Atom A3960 Thermal Protection**:
  - Video stream quality is automatically clamped to **720p / 1080p** (rejects 4K/2K) to prevent GPU/CPU thermal throttling and overheating on the head unit processor.
* **Cockpit HMI Controls**:
  - Play, pause, seek, volume, and fullscreen modes.
  - Multiline description text box with word wrapping.

---

### 4. M-Copilot (`m_copilot`)
Telemetry and performance companion for track and enthusiastic driving:

* Real-time readouts of engine RPM, vehicle speed, coolant and oil temperatures, g-force vectors, and live tire pressures.
* High-contrast M-Performance cockpit aesthetics with dark-theme styling.

---

## How to Install via MGU Store

To add this repository as a source in [MGU Store](https://github.com/robertnisipeanu/mgu-store):

1. On your iDrive central display, open **MGU Store > Sources > Add source**.
2. Enter this repository:
   ```text
   <your-github-username>/idrive7-custom-apps
   ```
3. Tap **OK**. The Store reads `mgu-repo.json` and lists all apps in this suite.
4. Tap any app to install!

---

## Manual Installation via ENET Cable (CarKit)

To flash all apps directly to your vehicle over an OBD-ENET cable:

```bash
# 1. Build all applications
python3 kit/tools/build.py

# 2. Package the CarKit installer
deploy/make-car-kit.sh

# 3. Push to car over SSH
HU=root@169.254.34.2 PORT=22 KEY=~/.ssh/id_mgu deploy/push-to-car.sh install
```

---

## Local Development & Live Emulator

Test and develop any app on your computer without being inside the car:

```bash
# Build a specific app package
python3 kit/tools/build.py quick_code

# Run live interactive emulator on http://localhost:8077
node kit/tools/emu.js quick_code

# Or run visual preview renderer
node kit/tools/preview.js dist/quick_code preview
```

### Controls in Emulator:
* **Mouse click / drag**: Central touchscreen input.
* **Mouse wheel / `[` `]`**: Turn iDrive rotary controller knob.
* **`Enter`**: Press iDrive controller knob.
* **Arrow keys**: Push controller knob up / down / left / right.

---

## Security & Privacy

* **Zero Hardcoded Secrets**: This repository contains no private API keys, client secrets, tokens, or personal identifiers.
* **Local Data Isolation**: Authentication tokens (`spotify_auth.json`), coding states (`quick_code_state.json`), and pre-coding snapshots (`quick_code_backups.json`) are stored strictly on the local vehicle head unit partition (`dataDir`).
* **Git Protection**: Sensitive file extensions (`*_auth.json`, `*_state.json`, `*_backups.json`, `*.key`, `*.pem`) are strictly excluded in `.gitignore`.

---

## License

This project is released under the GNU General Public License v3.0 or later.  
Not affiliated with or endorsed by Bayerische Motoren Werke (BMW) AG.
