# LinkedIn Page Posts Cleaner

A Manifest V3 Chrome extension that automates deletion of published LinkedIn company posts through the page UI. It runs only on the company admin published-posts page and keeps the existing timing, session-limit, retry, and stop controls.

## Load locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose this directory.
4. Open a LinkedIn company admin published-posts page, then open the extension popup.

## Store package

- Runtime icons: [`assets/icons/`](assets/icons/)
- Store promo tile and screenshots: [`store-assets/`](store-assets/)
- Icon source: [`assets/icon.svg`](assets/icon.svg)

The extension requires the LinkedIn page to be open in the active tab. Deletions are irreversible; review the target page and session limit before starting.
