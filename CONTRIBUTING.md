# Contributing

Thanks for helping improve LinkedIn Page Posts Cleaner.

## Before opening an issue

- Search existing issues first.
- Include the Chrome version, extension version, LinkedIn route, and a concise reproduction.
- Never include passwords, cookies, session tokens, private post content, or screenshots containing sensitive data.
- Remember that the supported route is the company admin published-posts page; unrelated LinkedIn pages are out of scope.

## Local verification

Run the checks that match your change:

```sh
node --check popup.js
node --check background.js
node --check content.js
node --check site/script.js
git diff --check
```

For UI changes, load the unpacked extension in Chrome and verify the ready, running, stopping, error, and completed states on a safe test page.

## Pull requests

- Keep changes focused and preserve the existing deletion behavior unless the change explicitly targets it.
- Explain the user-facing impact and any permission or privacy implications.
- Update screenshots or documentation when the popup workflow changes.
- Do not add remote scripts, analytics, or new permissions without a clear need and documentation.
