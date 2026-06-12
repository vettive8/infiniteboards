# Infinite Paper Web

Production-focused hosted version of the Infinite Paper experiment.

## Local setup

1. Create a Supabase project.
2. Run the SQL migration in `supabase/migrations`.
3. Copy `.env.example` to `.env.local`.
4. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
5. Run:

```powershell
npm install
npm run dev
```

## Cloudflare Pages

- Root directory: `web`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variables:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`

## Current scope

- Google OAuth and email magic link sign-in.
- Private boards by default.
- Invite editors by email.
- Realtime note sync with last-write-wins.
- Supabase Storage for pasted images.
- Import from same-origin local `v8.1.1` storage or JSON backup files.
