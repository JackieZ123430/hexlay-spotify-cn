# BMW iDrive 7 (MGU) — Custom Apps Suite

<p align="center">
  <b>A curated collection of custom applications for BMW iDrive 7 (MGU High / Intel Atom A3960), rendered at 60 fps directly on the vehicle's GPU.</b>
</p>

<p align="center">
  <img alt="60 fps" src="https://img.shields.io/badge/frame%20rate-60%20fps-2ea44f?style=for-the-badge">
  <img alt="OpenGL ES 2" src="https://img.shields.io/badge/render-OpenGL%20ES%202-1c6dd0?style=for-the-badge">
  <img alt="BMW iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
  <img alt="MGU Store Ready" src="https://img.shields.io/badge/MGU%20Store-Compatible-8957e5?style=for-the-badge">
</p>

---

## Credits & Acknowledgements

This repository is forked and built upon the foundational open-source BMW iDrive 7 platform:

* [**cauliflowermossgrape/idrive7-apps**](https://github.com/cauliflowermossgrape/idrive7-apps) — The foundational runtime, native OpenGL ES GPU rendering daemon, SOME/IP vehicle telemetry bridges, and TASU UDS diagnostic engine for BMW iDrive 7.
* [**mgu-store**](https://github.com/robertnisipeanu/mgu-store) — The in-car app store and package manager for BMW iDrive 7 by Robert Nisipeanu.

> [!NOTE]
> For core SDK extraction, toolchain documentation, low-level SOME/IP signal catalogs, and C/OpenGL renderer internals, please refer directly to the source repository at [**cauliflowermossgrape/idrive7-apps**](https://github.com/cauliflowermossgrape/idrive7-apps).

---

## Included Applications

### 1. QuickCode (`quick_code`)
**One-tap cockpit coding with automated backups for all BMW G-Series vehicles.**

![QuickCode Comfort](docs/screenshots/quick_code_comfort.png)

![QuickCode Ambient](docs/screenshots/quick_code.png)

* **Strict Low-Risk BDC Architecture (`0x40`)**:
  - Restricts all coding writes exclusively to the **Body Domain Controller (BDC_BODY3, `0x40`)**.
  - High-risk modules (**HU_MGU `0x63`**, **DME `0x12`**, **DSC `0x29`**) are completely excluded from coding writes, physically eliminating any risk of head unit black-screen, crash, or bootloop failures.
* **Safe Comfort & Lighting Options**:
  - **Auto Start/Stop Memory (`TC_MSA_MEMORY`)**: Permanently remembers the last button state across ignition cycles (stays OFF).
  - **Instant Mirror Fold on Lock (`KOMFORT_SCHLIESSEN`)**: Folds side mirrors immediately (`0.0s` delay vs factory `1.5s` hold delay).
  - **Continuous Window Roll-Up (`FH_TUERAUF_STOP_MAUT`)**: Windows continue rolling up uninterrupted when a door opens.
  - **One-Touch Tailgate Close (`HK_TASTE_TIPP_SCHLIESSEN`)**: One-touch close tailgate from key fob and driver door button without holding.
  - **5-Flash Comfort Turn Signals (`PIA_DEFAULT_TIPPBLINKEN`)**: One-touch indicator flashes 5 times instead of factory 3 flashes.
  - **Curb Monitor Mirror Tilt 70% (`ASP_BORDSTEIN_AUTOMATIK`)**: Passenger mirror dips 70% in reverse to show the curb and rim instead of pointing straight at the ground.
  - **Acoustic Lock/Unlock Chirp (`DEF_GLOBAL_LOCK_CLO`)**: Audible horn chirp confirmation on lock/unlock.
  - **Emergency Flashing Brake Lights (`BFD_ON`)**: Brake Force Display pulses outer brake lamps under heavy deceleration.
  - **Ambient RGB Color Palettes**: Presets for BMW Bronze (OEM), M Neon Cyan, Miami Violet, Acid Lime, BMW Blue (OEM), and M Crimson Red with live interior light tube preview.
* **Automated Pre-Coding Backups & 1-Tap Rollback**:
  - Automatically captures a timestamped snapshot of all parameters before every modification.
  - Dedicated **"Backups & Rollback"** tab with 1-tap `[RESTORE]` rollback and `[RESTORE ALL FACTORY OEM DEFAULTS]`.
* **Vehicle Safety Interlocks**:
  - Strictly locks coding if engine is running (RPM > 0) or vehicle is in motion (Speed > 0 km/h).
  - Enforces Terminal 15 Diagnostic Mode (3-press Start/Stop, engine off) matching BimmerCode and ISTA safety protocols.

---

### 2. Spotify (`spotify`)
**Native Spotify Connect controller and library browser directly on the iDrive 7 central display.**

![Spotify](docs/screenshots/spotify.png)

* **Zero-Terminal In-Car QR Code Pairing**:
  - Built-in background authentication server running on port `8888`.
  - Connect your phone to the car's Wi-Fi hotspot or Wireless CarPlay and scan the QR code on the **"Connect"** tab.
  - Mobile login page opens: tap **"Connect with Spotify"**, approve on Spotify, and your car screen immediately loads your personal playlists, saved songs, and devices.
  - **No terminal, no SSH, and no Node commands required.**
* **Automatic Background Token Refresh**:
  - Automatically refreshes tokens in the background on expiration across ignition cycles.
* **1-Tap Disconnect / Switch Account**:
  - `[DISCONNECT / SWITCH ACCOUNT]` button wipes the active session with one touch so passengers or new drivers can pair their accounts.
* **Cockpit UI**:
  - 60 fps animated mini equalizers on active tracks.
  - Browse personal playlists, saved library, and queue.
  - Instant device switching across Spotify Connect targets.

---

### 3. M-Cinema (`m_cinema`)
**In-car cinema and video receiver for passengers and parked entertainment.**

![M-Cinema](docs/screenshots/m_cinema.png)

* **Phone-to-Car Video Casting**:
  - In-car background receiver server on port `8090`.
  - Scan the cockpit QR code to cast YouTube, web videos, or local media directly to the central screen.
* **Intel Atom A3960 Thermal Protection**:
  - Stream quality is clamped to **720p / 1080p** (rejects 4K/2K) to prevent GPU/CPU thermal throttling and overheating on the head unit processor.
* **Cockpit HMI Controls**:
  - Play, pause, seek, volume, and fullscreen modes.
  - Multiline description text box with word wrapping.

---

### 4. M-Copilot (`m_copilot`)
**Performance telemetry, track metrics, and telemetry logging for BMW M & G-Series vehicles.**

![M-Copilot](docs/screenshots/m_copilot.png)

* Real-time readouts of engine RPM, vehicle speed, coolant and oil temperatures, g-force vectors, and live tire pressures.
* High-contrast M-Performance cockpit aesthetics with dark-theme styling.

---

## How to Install via MGU Store

The recommended way to install and update these applications is through [**MGU Store**](https://github.com/robertnisipeanu/mgu-store):

1. On your iDrive central display, open **MGU Store > Sources > Add source**.
2. Enter this repository directly:
   ```text
   hexlay/idrive7-custom-apps
   ```
3. Tap **OK**. MGU Store fetches `mgu-repo.json` and immediately displays all apps.
4. Tap any app to install!

---

## Platform & Developer Documentation

For everything else, including:
* **SDK Extraction & Setup** (`kit/tools/extract_sdk.js`)
* **Vehicle SOME/IP Signal Catalogs**
* **Native C / Wayland / OpenGL ES GPU Renderer** (`mgu-render`)
* **Controller Input Hooks** (`mgu-inputgate`)
* **OBD-ENET / SSH Deployment Scripts**
* **Creating New Applications**

👉 **Please visit the source repository: [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)** and the [**MGU Store Guide**](https://github.com/robertnisipeanu/mgu-store).

---

## Privacy & Security

* **Zero Hardcoded Secrets**: This repository contains no private API keys, client secrets, tokens, or personal identifiers.
* **Local Data Isolation**: Authentication tokens (`spotify_auth.json`), coding states (`quick_code_state.json`), and pre-coding snapshots (`quick_code_backups.json`) are stored strictly on the local vehicle head unit partition (`dataDir`).
* **Git Protection**: Sensitive file extensions (`*_auth.json`, `*_state.json`, `*_backups.json`, `*.key`, `*.pem`) are strictly excluded in `.gitignore`.

---

## License

This project is released under the GNU General Public License v3.0 or later.  
Not affiliated with or endorsed by Bayerische Motoren Werke (BMW) AG.
