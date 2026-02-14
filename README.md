# Raindrop Bookmark Sync

Two-way bookmark synchronization between Firefox/Chrome and [Raindrop.io](https://raindrop.io).

## Features

- **Two-way sync** - Changes in browser sync to Raindrop.io and vice versa
- **Folder mapping** - Choose which bookmark folders sync with which Raindrop collections
- **Nested folders** - Full support for folder hierarchies
- **Real-time sync** - Bookmark changes sync immediately
- **Periodic sync** - Configurable interval (1-60 minutes) to pull changes from Raindrop.io
- **Cross-browser** - Works in Firefox (Manifest V2) and Chrome (Manifest V3)

## Installation

### From Browser Stores

- **Firefox**: [Add-ons for Firefox](https://addons.mozilla.org/) *(coming soon)*
- **Chrome**: [Chrome Web Store](https://chrome.google.com/webstore/) *(coming soon)*

### Manual Installation (Development)

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build:firefox   # For Firefox
   npm run build:chrome    # For Chrome
   ```
4. Load the extension:
   - **Firefox**: `about:debugging` > This Firefox > Load Temporary Add-on > select `dist/firefox/manifest.json`
   - **Chrome**: `chrome://extensions` > Developer mode > Load unpacked > select `dist/chrome/`

## Setup

1. Get a Test Token from Raindrop.io:
   - Go to [Raindrop.io Settings > Integrations](https://app.raindrop.io/settings/integrations)
   - Create a new app (or use existing)
   - Copy the **Test token**

2. Configure the extension:
   - Click the extension icon > Open Settings
   - Paste your Test Token and click **Save & Connect**

3. Create folder mappings:
   - Select a bookmark folder and a Raindrop.io collection
   - Click **Add Mapping**
   - Bookmarks will sync automatically

## How It Works

- **Raindrop.io is the source of truth** - When conflicts occur, Raindrop.io data takes priority
- Changes in mapped bookmark folders are pushed to Raindrop.io immediately
- Changes in Raindrop.io are pulled periodically (configurable interval)
- All operations go through a retry-capable queue to handle transient failures

## Development

```bash
npm install              # Install dependencies
npm run watch:firefox    # Watch mode for Firefox
npm run watch:chrome     # Watch mode for Chrome
npm run start:firefox    # Run Firefox with extension
npm run start:chrome     # Run Chrome with extension
npm run build:all        # Build for both browsers
npm run lint             # Lint extension
npm run package:all      # Package for store submission
```

## Permissions

- `bookmarks` - Read and modify bookmarks
- `storage` - Store settings and sync data locally
- `alarms` - Schedule periodic sync
- `https://api.raindrop.io/*` - Communicate with Raindrop.io API

## Privacy

This extension does not collect any personal data. All data is stored locally on your device.

See [Privacy Policy](PRIVACY_POLICY.md) for details.

## Support

If you encounter issues or have questions:
- [Open an issue](https://github.com/victorkasap/raindrop-bookmark-sync/issues)

## License

MIT License - see [LICENSE](LICENSE) for details.
