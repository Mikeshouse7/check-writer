# Check Writer

Write and print checks on VersaCheck / ValueChex Form #1000 (check on top,
QuickBooks layout). Multiple accounts, bank logos, E-13B bank line, check
register, alignment arrows.

The page has no bank numbers in it. Accounts and checks are stored on the
server (Railway volume) behind `APP_PASSCODE`, so the phone and the PC share
one register. Locking a device clears its local copy.

Run locally: `node server.mjs` → http://localhost:5185 (data in `data/`).
Online: Railway, Node 20+, a volume mounted for data, `APP_PASSCODE` set.
Custom domain: checkwriter.theproductgenerator.com.

First time online: open the site, enter the code, then Register → Restore
backup and pick your saved backup .json. It uploads and syncs from then on.
