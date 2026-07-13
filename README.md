# Impulse Command Center

A calm, offline-capable workspace for Moon and Kira to manage client projects, studio operations, outreach, deadlines, deliverables, notes and partner meetings.

## Run locally

```bash
npm install
npm run dev
```

Without a Dexie Cloud URL the development server shows generic sample records in IndexedDB. Production builds start empty until an authenticated owner imports data.

## One-time Command Center migration

The prepared file is `migration/command-center-import.json`. It contains the verified snapshot of the existing workbook and is intentionally ignored by Git, so client and sales information cannot enter the public repository or JavaScript bundle. In **Settings → Command Center import**, select this file once after signing in. The original workbook remains unchanged.

## Connect Dexie Cloud

1. Create a database from this folder:

   ```bash
   npx dexie-cloud create
   ```

2. Copy `.env.example` to `.env.local` and set `VITE_DEXIE_CLOUD_URL` to the generated database URL.
3. Whitelist local and production origins:

   ```bash
   npx dexie-cloud whitelist http://localhost:5173
   npx dexie-cloud whitelist https://papertowel2030-hub.github.io
   ```

4. Restart the dev server. Sign in using the email OTP flow.
5. Open Settings and invite the partner email. The invitation shares only the `Impulse Workspace` realm.

Never commit `dexie-cloud.key`; it is excluded by `.gitignore`.

## Backups

- In Settings, use **Export Excel backup** weekly and place the dated workbook in Google Drive.
- Monthly, run:

  ```bash
  npx dexie-cloud export
  ```

  Store the restoreable ZIP off-site. Test restoration with `npx dexie-cloud import <backup.zip>` against a separate test database.

## Deploy to GitHub Pages

The included workflow publishes every push to `main`. In the repository settings, enable GitHub Pages with **GitHub Actions** as the source. Add all three values from `.env.example` as repository variables: `VITE_DEXIE_CLOUD_URL`, `VITE_OWNER_EMAIL_HASHES`, and `VITE_MEMBER_EMAIL_HASHES`.

The marketing website remains separate. Share the dashboard URL privately.

## Quality checks

```bash
npm run check
npm test
npm run build
```
