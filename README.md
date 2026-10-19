# SwipeClean

SwipeClean is a local-first Expo app for reviewing photos and videos on your device. Swipe right to keep, left to set aside, or up to revisit later. Nothing is removed from the library until you inspect the pending list and explicitly confirm.

## Run on an iPhone

1. Install Node.js and npm, then run `npm install` in this folder.
2. Run `npx expo start`.
3. This project uses Expo SDK 57. Make sure Expo Go on the device supports SDK 57, then scan the QR code with the iPhone camera.
4. Grant photo access when prompted. Limited photo access is supported; use Settings to manage the selected items.

Photo permissions, library thumbnails, and deletion prompts must be verified on a physical iPhone. SwipeClean does not permanently erase photos; iOS may retain removed items in Recently Deleted.

## Checks

- `npm run typecheck` — strict TypeScript check.
- `npx expo install --check` — verify Expo SDK package compatibility.
