# Development Guide

## Prerequisites

- **Node.js** v16+
- **npm** (comes with Node.js)
- **Expo CLI** (install globally: `npm install -g expo-cli`)
- **Expo Go** app on your Android phone (for dev testing) — available from Google Play Store
- **Android device** for testing (emulator or physical phone)

## Getting Started

```bash
cd TrailTrackerXP
npm install
npx expo start          # Opens Expo DevTools with QR code
```

Open Expo Go on your phone, scan the QR code, and grant location permissions.

> **Note:** For background location to work, go to Android Settings → Apps → Expo Go → Permissions → Location → "Allow all the time".

## Project Structure

```
TrailTrackerXP/
├── App.js                        # Navigation, theming, font loading
├── app.json                      # Expo config (permissions, splash, icons)
├── babel.config.js               # Babel config (babel-preset-expo)
├── screens/
│   ├── TrackingScreen.js         # GPS tracking + live map (1800+ lines)
│   ├── CalendarScreen.js         # Activity calendar
│   ├── StatsScreen.js            # Walking/running/biking stats, charts, recent activities
│   ├── XPScreen.js              # XP, levels, achievements, challenges, streaks
│   ├── ActivityDetailScreen.js   # Per-activity detail + route playback
│   └── SettingsScreen.js         # Preferences and import/export
├── utils/
│   ├── theme.js                  # Theme colours (dark-only TubePulse palette)
│   ├── storage.js                # AsyncStorage CRUD, distance calc
│   ├── activityTypes.js          # Canonical type labels, colours, GPX values, metric modes
│   ├── fileStorage.js            # File-based GPX/JSON storage
│   ├── gamification.js           # XP, levels, achievements, challenges
│   └── stravaImport.js           # GPX/CSV import
├── components/
│   └── Icons.js                  # Custom SVG icon set (react-native-svg)
├── assets/                       # App icons, splash, notification icons
│   └── fonts/                    # Inter font family
└── docs/                         # Project documentation
```

## Data Storage Architecture

The app uses a dual storage system:

### AsyncStorage (cache)
- Fast access for daily use
- Stores activity metadata, settings, gamification state
- Key prefix: `@trail_tracker_*`

### File System (persistent)
- Each activity saved as an individual GPX 1.1 file in `documentDirectory/activities/`
- Gamification state in `documentDirectory/activities/gamification.json`
- Export backups in `documentDirectory/export/`
- GPX files use the standard GPX 1.1 format for portable activity history

### Recovery
If cache data is lost or corrupted:
1. Settings → Data Storage → **Recover from GPX Files** to restore from the persistent GPX files
2. Settings → Data Storage → **Save to GPX Files** to persist any cache-only activities

## Importing from Strava

1. Go to Strava.com → Settings → My Account → "Download or Delete Your Account" → "Get Started" → "Request Your Archive"
2. Wait for the email, download and unzip the export
3. Settings → Data Storage → **Import from Strava**
4. Select `.gpx` files from the export's `activities/` folder
5. (Optional) Add `activities.csv` for better metadata
6. Activities are classified as Walk/Run/Ride based on GPX type. Strava hikes remain walks.

New Strava `Run`/`running` imports are stored as `running`. Older runs imported by versions that
classified them as walks are not guessed or migrated automatically; open the saved activity and
use the three-way conversion picker if needed.

## Path Overlay Feature (Walking Mode)

When activity type is Walking, the app can overlay OpenStreetMap tiles showing footpaths, bridleways, and trails at 70% opacity. Toggle via the "🗺️ Paths" button on the tracking screen.

- Tile source: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- Uses `UrlTile` from react-native-maps
- Only shown for walking (disabled for running and biking to reduce clutter)
- Free, no API key required, good UK footpath coverage

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native + Expo (SDK 51) |
| Navigation | React Navigation (bottom tabs + native stack) |
| Maps | react-native-maps + WebView tile caching |
| Storage | AsyncStorage + FileSystem (JSON + GPX) |
| Charts | Custom SVG (react-native-svg) |
| Fonts | Inter (@expo-google-fonts/inter) |
