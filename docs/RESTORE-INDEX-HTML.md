# Restore index.html (required)

A tool write truncated `index.html` on `feature/multi-provider-payment-backend`.
The complete file is preserved on the backup branch.

## Restore (local git)

```bash
git fetch origin
git checkout feature/multi-provider-payment-backend
git checkout backup/pre-stage-a-identity-2026-11-07 -- index.html
# optional: apply gateway CSS from docs/patches/gateway-alignment-fix.css
git add index.html
git commit -m "restore(index.html): recover full UI from backup/pre-stage-a-identity-2026-11-07"
git push origin feature/multi-provider-payment-backend
```

## Backup reference

- Branch: `backup/pre-stage-a-identity-2026-11-07`
- Commit: `c9ec8d21e3e6dac116f8b505d5c0a63966315078`
- File SHA: `120b5d53f07358087cbeb1c5548951304953e650`

After restore, the app UI, bootstrap, and storage modules work again.
Live collection and production APK remain disabled.
