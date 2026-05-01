SAVVEY — COWORK CONTEXT BRIEF
Last updated: 29th April 2026 — End of session

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
User: vincentlundy1234
GitHub: github.com/vincentlundy1234/savvey
Vercel: vercel.com/vincentlundy1234s-projects/savvey
Live URL: https://savvey.vercel.app
Local files: C:\Users\vince\OneDrive\Desktop\files for live\

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEPLOY PROCESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "description"
git push origin master
Vercel auto-deploys in ~30 seconds. No manual step needed.
NOTE: Always use "git push origin master" not just "git push"
— plain git push has silently failed in previous sessions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
files for live\
├── index.html      ← full frontend, all screens, all JS
├── sw.js           ← service worker v6 (do not touch)
├── vercel.json     ← 256MB memory, 15s timeout (do not touch)
├── manifest.json   ← PWA manifest (do not touch)
└── api\
    ├── search.js   ← price search proxy v6.3
    └── scrape.js   ← direct URL scraper v1.0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TECH STACK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Frontend: single index.html (no build step, no framework)
Search API: Serper via /api/search.js (Vercel serverless)
Scrape API: /api/scrape.js (Vercel serverless)
Database: Supabase (price alerts)
Hosting: Vercel free tier
Fonts: Nunito + Inter (Google Fonts)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BRAND
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name: Savvey
Tagline: spend smart.
Primary colour: #2a6b22 (green)
Logo: Green S badge, red full stop only red element
Pips: 1-2 red / 3 amber / 4-5 green
Verdicts: 1=Walk away / 2=Better deal available /
          3=Worth a look / 4=Pretty good / 5=Best price
Voice: consumer-first, dry wit, never accusatory
Never say: "ripped off" or "rip-off"
Buy button: always green regardless of verdict

OPERATING RULES FOR COWORK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Always edit index.html directly in the local folder
2. Always deploy with git push origin master (not git push)
3. Never provide snippets — full file awareness required
4. Never revert confirmed fixes
5. All prices must be parsed as parseFloat before filtering
6. globalReset() must be called first in every search path
7. After every deploy, verify on Vercel deployments page
   that the commit appears as Current Production