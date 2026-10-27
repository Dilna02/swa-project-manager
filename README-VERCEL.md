# SWA Project Manager: deploy to Vercel (public-safe)

This repository contains only code. Your project data never goes to GitHub. It is imported once into the database from your own computer.

You need accounts on GitHub, Vercel and Neon (all free to start), plus Node.js 20 or newer on your computer.

---

## Step 1: Put the code on GitHub

1. On github.com, click **New repository**. Name it `swa-project-manager`. Choose **Public** or **Private** (either works). Click **Create repository**.
2. Unzip `swa-vercel-public.zip`. Select everything inside the folder (not the folder itself) and drag it into the GitHub page. Click **Commit changes**.
3. Before committing, check the file list. There must be no `seed.json`, `.env` or `.env.local`.

## Step 2: Create the database (Neon)

1. In Vercel, click **Storage → Create Database → Neon Postgres** (if the names differ, choose the closest match). Choose the free plan.
2. Copy the connection string. It ends with `?sslmode=require`. Keep it somewhere safe.

## Step 3: Create image storage (Vercel Blob)

1. In Vercel, click **Storage → Create → Blob**.
2. Connect it to your project once the project exists (Step 5).

## Step 4: Import your data (one time, on your computer)

1. Get `seed.json` from the earlier `swa-project-manager.zip`. Put it in the project folder on your computer. Do not upload it to GitHub.
2. Open a terminal in the project folder and run:

        npm install
        DATABASE_URL="paste-your-neon-string-here" npm run import-seed

3. You should see: `Imported 5 users, 19 projects, 16 tasks, 2 updates.`
4. If you run it again, it refuses, so your data is safe.

## Step 5: Deploy

1. In Vercel, click **Add New… → Project**, choose your `swa-project-manager` repository and click **Import**.
2. Leave **Framework Preset** as **Other**. Leave **Build Command** and **Output Directory** empty.
3. Under **Environment Variables**, add:

| Name | Value |
|---|---|
| `DATABASE_URL` | The Neon connection string from Step 2 |

4. Click **Deploy**.
5. Go to **Storage**, open the Blob store from Step 3 and connect it to this project. Then open **Deployments** and click **Redeploy** on the latest one. This sets the image token automatically.

## Step 6: Check and secure

1. Open the address Vercel gives you (for example `swa-project-manager.vercel.app`).
2. Sign in as **dilna@gmail.com** with password **123**. This is the imported admin account.
3. **Change the password right away** in the **Account** tab. The old password is public knowledge to anyone who has read this guide.
4. Check **Projects** shows 19 projects and **Tasks** shows 16 tasks.
5. Add a test task with an image. If the thumbnail appears, image storage works.

## Step 7: Add your domain (optional)

1. In your project, go to **Settings → Domains**, type the domain (for example `pm.yourcompany.com`) and click **Add**.
2. Add the DNS record Vercel shows at your domain provider. HTTPS is set up automatically.

## Step 8: Share

Create a login for each developer in the **Developers** tab, and send each one the address, their username and their password.

---

## Making the repository public

Public is safe once the steps above are done, because the repository holds only code:
- `seed.json` is excluded by `.gitignore`, and it was never committed.
- The database address and the image token live in Vercel's settings, not in the code.
- Passwords are stored as hashes in the database, never in the code.

Before you change it to public, check the file list on GitHub once more for `seed.json` or `.env`.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Database not ready. Check DATABASE_URL" | The `DATABASE_URL` setting is missing or wrong. Fix it, then **Redeploy**. |
| Images don't upload | Check the Blob store is connected to this project. Then **Redeploy**. |
| "Too many attempts" | Wait 15 minutes. |
| Anything else | In Vercel, open the project's **Logs**, copy the error and send it to me. |

## Things to know

- Images get random public links. Anyone with the link can view that image, so avoid uploading sensitive screenshots.
- The first request after a quiet period can take a second or two.
- The app stores everything in Neon, so you can redeploy at any time without losing data.

## Running it on your computer (optional)

    npm install
    DATABASE_URL="your-neon-string" npm start

Then open http://localhost:3000.
