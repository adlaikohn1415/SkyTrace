# SkyTrace AR Web MVP

Installable iPhone web app/PWA that uses the camera as a background and overlays predicted satellite positions with one moving label per satellite and optional future flight paths.

## What is included

- Full-screen camera view
- iPhone home-screen standalone mode through PWA manifest
- Location + compass/orientation-based satellite overlay
- Single moving label per satellite
- Optional flight path line ahead of each satellite
- Filters: visible/bright, all, Starlink, stations, weather, GPS/navigation
- Minimum elevation filter
- Max on-screen labels filter
- Night vision mode
- Horizon guide
- Live CelesTrak TLE fetch with local cache
- Demo fallback TLEs for testing if live fetch fails

## Important limitation

This does not visually detect satellites in the camera feed. It predicts positions from orbital data, GPS, time, and phone orientation. Compass drift is the largest source of visual misalignment.

## Test on iPhone without a computer

You still need the files hosted somewhere over HTTPS. Camera and motion permissions will not reliably work from a random local file.

Fast hosting options:

1. Upload this folder to GitHub.
2. Enable GitHub Pages, or deploy to Netlify/Vercel/Cloudflare Pages.
3. Open the HTTPS URL in Safari on your iPhone.
4. Tap Share → Add to Home Screen.
5. Open SkyTrace from the new home-screen icon.
6. Tap Enable Camera + Sensors.
7. Allow Camera, Location, and Motion/Orientation permissions.

## Test with a computer temporarily

```bash
npm install
npm run start
```

Then open the printed HTTPS/local URL in Safari on your iPhone. For camera permissions, HTTPS is strongly preferred. Vite local HTTP may work on localhost but not reliably from another phone.

## Recommended iPhone testing checklist

- Test outdoors with clear sky.
- Slowly move the phone in a figure-eight to calibrate compass.
- Turn on horizon guide and point at the real horizon.
- Start with “Likely visible / bright” and max labels around 10–20.
- Try “Space stations” first because ISS/Tiangong are easier to reason about.
- Use night mode outdoors to reduce glare.

## Production improvements

- Add a manual alignment tool: tap Moon/Polaris/known star and correct heading offset.
- Add satellite brightness prediction and sun/shadow visibility checks.
- Add pass alerts.
- Add offline packaged TLE snapshots.
- Add proper privacy page before public deployment.
- Add server-side TLE caching to avoid CORS/rate-limit issues.


## iOS permission fix notes

This build requests DeviceOrientation/DeviceMotion before camera/location because iOS requires motion/orientation permission to be requested directly from the user tap. The app no longer leaves the permission panel up when camera works but motion/location are delayed or unavailable.

If updating from an older build on GitHub Pages, delete the home-screen icon, clear/reload Safari, then add the app to Home Screen again.
