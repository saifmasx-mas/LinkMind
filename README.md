# LinkMind — ذاكرتك الثانية الذكية

LinkMind is a web app (PWA) that turns links, videos and books into AI
summaries and actionable checklists, saved in a personal cloud library you
can search by meaning and chat with. Paste a YouTube / article / TikTok /
Facebook link, or upload a PDF / Word book, and get a clean title, a short
summary, a category and a checklist — plus a Telegram bot that saves links
from inside Telegram.

## Tech stack

- Next.js 15 (App Router), React 19, TypeScript (strict)
- Tailwind CSS v4
- Supabase (Auth + Postgres + RLS)
- Google Gemini (`@google/genai`) for summaries and embeddings
- pdfjs-dist (PDF text in the browser), mammoth (Word), cheerio, youtube-transcript
- Deployed on Vercel

## Run locally

```bash
npm install
npm run dev
```

## Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Where it is used |
| --- | --- |
| `GEMINI_API_KEY` | All Gemini calls (server only) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase client (browser + server) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase browser client |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side admin client (secret — never expose in the browser) |
| `TELEGRAM_BOT_TOKEN` | Telegram webhook |
| `TELEGRAM_BOT_USERNAME` | Telegram link generation (server) |
| `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` | Telegram button in the UI |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook verification |

## Supabase setup

1. Create a Supabase project.
2. Apply the migrations in `supabase/migrations/` (in order):
   - `20261123000000_telegram_links.sql` — Telegram linking tables.
   - `20261124000000_bookmarks_user_profiles.sql` — `bookmarks` and
     `user_profiles` tables with row-level security (owner-only policies)
     and the atomic `deduct_credit` function.
   Use `supabase db push` or paste the files into the Supabase SQL editor.
3. In Supabase Auth settings, set the Site URL to your deployed domain and
   add `https://<your-domain>/auth/callback` to the redirect URLs.
4. If you created `bookmarks` / `user_profiles` by hand in the dashboard,
   check that their columns match the migration (especially
   `bookmarks.embedding`, stored as `jsonb` here). Do **not** run the
   migration blindly over a different schema.

## Telegram bot

1. Create a bot with BotFather, set `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_BOT_USERNAME` and `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`.
2. Set the webhook with a secret:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>`
3. In the app, click the Telegram button while signed in — it creates a
   one-time link token (valid 10 minutes) and opens `t.me/<bot>?start=<token>`.

## Deploy on Vercel

Connect the GitHub repository, set the environment variables above for the
Production environment, and deploy. The latest deployment is the `main`
branch. Note: a new deployment is required after changing environment
variables.

## Credits

Every user starts with 5 free credits; each AI analysis deducts 1 credit.
The PRO plan is not implemented yet — the pricing buttons are disabled and
say so in the UI.
