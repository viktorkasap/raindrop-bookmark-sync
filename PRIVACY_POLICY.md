# Privacy Policy for Raindrop Bookmark Sync

**Last updated:** February 2026

## What This Extension Does

Raindrop Bookmark Sync is a browser extension that synchronizes bookmarks between your browser (Firefox/Chrome) and your Raindrop.io account.

## Data Collection

This extension does **NOT** collect, transmit, or share any personal data with third parties.

## Data Stored Locally

The extension stores the following data locally on your device using the browser's built-in storage API (`browser.storage.local`):

- **Raindrop.io API Test Token** - Used to authenticate API requests to your Raindrop.io account. The token is stored locally and never sent anywhere except to the official Raindrop.io API.
- **Folder mappings** - Configuration of which browser bookmark folders are linked to which Raindrop.io collections.
- **Bookmark link records** - Internal records that track which browser bookmarks correspond to which Raindrop.io items, used to detect changes and avoid duplicates.
- **Sync queue and statistics** - Pending sync operations and basic sync status information (last sync time, error count).

## Network Requests

The extension communicates **exclusively** with the official Raindrop.io API at `https://api.raindrop.io`. No other external services are contacted. All requests are made over HTTPS.

The following types of API requests are made:
- Reading and writing bookmarks (raindrops) in your Raindrop.io account
- Reading and creating collections in your Raindrop.io account
- Retrieving your Raindrop.io user profile (to display your name in the extension UI)

## Data Sharing

No data is shared with third parties. No analytics, tracking, or telemetry of any kind is used.

## Data Deletion

All locally stored data can be deleted by:
- Removing the extension from your browser (all extension data is automatically deleted)
- Using the browser's built-in option to clear extension storage

Your Raindrop.io API token can be revoked at any time from [Raindrop.io Settings > Integrations](https://app.raindrop.io/settings/integrations).

## Permissions

- **bookmarks** - Required to read and sync your browser bookmarks
- **storage** - Required to store settings, sync state, and your API token locally
- **alarms** - Required to schedule periodic sync checks
- **https://api.raindrop.io/** - Required to communicate with the Raindrop.io API

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/victorkasap/raindrop-bookmark-sync/issues

## Changes to This Policy

Any changes to this privacy policy will be posted at this URL. The extension itself does not auto-update this policy.
