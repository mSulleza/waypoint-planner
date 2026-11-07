# Screen checks

Every screen task runs these checks in the Browser pane before it commits. The PR lists the tap counts and the audit results and carries the screenshots. Start the web app with `preview_start {name: "waypoint-web"}` and open the screen on a sample (`?sample=<id>`) or a local household.

1. **Taps.** Count the taps for the screen's main jobs from where a person starts, and compare them with the estimate in spec §7.

2. **Mask audit.** Turn the eye on. Wait for amounts to fade (150 ms). A hidden Browser pane throttles animation frames, so take a screenshot first, then run with `javascript_tool`:

   ```js
   window.__waypointAudit()
   ```

   Both lists must be empty:
   - `smallControls`: visible controls narrower or shorter than the touch target (44 px; 48 on Android).
   - `maskedDigits`: digits inside a `[data-money]` node (every `<Money>`), and any other text or input that reads as an amount (a digit beside a currency symbol or ISO code).

   Open each sheet the screen has and run it again. A full page load turns the eye off again, so open a prefilled sheet with the eye on by navigating inside the app. Where no button leads there yet, call the app's router from the console in development: find the module id of `expo-router/build/imperative-api.js` in `__r.getModules()` (match on `verboseName`), then `__r(id).router.push({ pathname: '/add', params: { mode: 'move', to: '<card id>' } })`. With the eye off, the audit lists every amount on screen, which shows it can see them. Also check there is one level 1 heading on screen (tabs visited earlier stay mounted with `display: none`):

   ```js
   [...document.querySelectorAll('h1')].filter((h) => h.offsetParent !== null).length // 1
   ```

3. **Page title** (WCAG 2.4.2). The browser tab names the screen on top: after a full reload of the screen's address, after opening a sample from Welcome, and after moving to the screen from another one. The Browser pane often draws no animation frames, so this reads the title without waiting for one:

   ```js
   const h1 = [...document.querySelectorAll('h1')].filter((h) => h.offsetParent !== null).map((h) => h.textContent)
   ;({ title: document.title, h1 }) // title is '<h1> · Waypoint'; Welcome's h1 is 'Waypoint' and its title 'Welcome · Waypoint'
   ```

4. **200% zoom.** `resize_window` to width 640, height 450, and screenshot. This emulates 200% zoom of a 1,280 x 900 window by halving the CSS viewport, as real browser zoom does. CSS `zoom` on the root element does not change the window width or the breakpoints, so it is not a substitute.

5. **Reflow at 320 px** (WCAG 1.4.10). `resize_window` to width 320 (height 700) and screenshot. No sideways scroll and no clipped number:

   Content inside its own sideways scroller (Months' strip, a wide chart table) may run past the edge; everything else may not.

   ```js
   const W = innerWidth
   const scrolls = (e) => e && e !== document.body && (/auto|scroll/.test(getComputedStyle(e).overflowX) || scrolls(e.parentElement))
   const over = [...document.querySelectorAll('#root *')].filter((e) => {
     const r = e.getBoundingClientRect()
     return r.width > 0 && (r.right > W + 0.5 || r.left < -0.5) && !scrolls(e.parentElement)
   }).length
   const clipped = [...document.querySelectorAll('[data-money]')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent)
   ;({ W, scrollWidth: document.documentElement.scrollWidth, over, clipped }) // scrollWidth === W, over 0, clipped []
   ```

6. **Tabular figures.** Figures in columns line up digit for digit. Instrument Sans has tabular figures, but symbols it lacks (₱, ≈) fall back to the platform font, so look at the screenshots, not only the code.

7. **Light and dark.** Take the screenshots in both: `resize_window` with `colorScheme` `light`, then `dark`, and reload. Settings' Appearance must be on System, since a pinned Light or Dark ignores `colorScheme`.

8. **Reset.** `resize_window` with preset `desktop`, and `preview_stop` the server you started.

Operating-system text sizes are checked on phones in P9-1 and P9-3.
