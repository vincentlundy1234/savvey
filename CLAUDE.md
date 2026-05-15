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
Tagline: shop smart.   (updated 2 May 2026 — was "spend smart.")
Primary colour: #2a6b22 (green)
Logo: Green S badge, all-green (NO red dot — that earlier brand description is superseded as of 2 May 2026)
Score name: Savvey Score   (renamed 2 May 2026 — was "Savvey Signal")
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

1. THE UNIVERSAL ROUTING MATRIX (The 4 Inputs & 3 Outcomes)
There are exactly four ways a user inputs data: Snap (Camera), Type (Text), Scan (Barcode), or Paste (URL). All four inputs must route through the exact same backend pipeline and resolve into one of three strict outcomes.

Outcome 1: Exact Match (High Confidence)

Trigger: A barcode, a URL, or a highly specific text/snap (e.g., "Ninja AF300UK", "Sony PS5 Pro").

Destination: Route DIRECTLY to #screen-result (The Four Pillars + Retailer Stack).

Action: Do not show any disambiguation.

Outcome 2: Variant Family (The Closed Loop)

Trigger: Broad family name with known models (e.g., "PS5", "iPhone 16").

Destination: Route to #screen-disambig (Clean UI). Hide "Budget/Premium" pills and generic icons. Show a clean list of variant names (e.g., Slim Disc, Pro).

Action: Tapping a variant intercepts the click, silently enters the variant name into the search flow, and routes to Outcome 1. Do NOT link externally.

Outcome 3: Generic Noun (The Open Loop)

Trigger: Unbranded, generic items (e.g., "teapot", "white mug").

Destination: Route to #screen-disambig (Generic Tiers).

UI Required: Display the color-coded "BUDGET", "TOP RATED", and "PREMIUM" pills.

Action: Tapping these acts as an external affiliate link out to Amazon.

2. UI/UX SOURCE OF TRUTH (The Four Pillars & Retailer Stack)
For Outcome 1 (Exact Match), the #screen-result UI is locked. Do not alter the CSS layout. It must contain exactly:

The Four Pillars (Data Presentation):

Identity: The exact Product Name and a clean cropped image.

Best Price: The lowest verified price (£X.XX) with the Retailer Name underneath.

Market Context: The median average price across the market and the total number of retailers checked (e.g., "Average £399 across 5 stores").

The AI Verdict: A 1-2 sentence summary from Haiku and the colored "Verdict Pill" (e.g., "Great Price").

The Retailer Stack (The Revenue Engine):
Immediately below the Four Pillars, you must render the affiliate links pulled from SerpAPI.

Amazon Primary: If verified, featured at the top in green with price and prime/delivery subtext.

Competitors: 2 to 4 other retailers (e.g., Currys, Argos, Game) listed below with their respective logos, prices, and stock text.

Routing: Every card in this stack must be a functional, external affiliate link.

3. BACKEND & DATA CONSTRAINTS (Zero Timeouts, Zero Garbage)
To prevent Vercel 504 Timeouts and garbage data, enforce the following:

Split-Routing (No Monoliths): Data extraction (/api/identify) and AI text synthesis (/api/synthesize) must remain decoupled. Render the prices instantly; let the AI text shimmer/load asynchronously. Graceful degradation is mandatory—if the AI text fails, the user must still see the prices and affiliate links.

Price Sanity (Outlier Rejection): Never display cheap accessories as the "Best Price" for a main console. Calculate the median price of all valid SerpAPI results and discard anything less than 50% of the median.

Deep Price Extraction: When parsing SerpAPI, check all possible price fields (extracted_price, price, price_range.lower, offers[0].price, lowest_price). Do not drop aggregator results just because the primary price string is null.

No Silent Failures: If 0 prices are found, or an exception is thrown, the frontend MUST display a clean message indicating exactly why (e.g., "Searched X listings, none with valid UK prices" or the specific Error string). Never dump the user to a blank screen or the Home screen without an explanation.

SAVVEY — auto-push watcher is set up. Use it as priority. Do not push from bash.
Repo folder: C:\Users\vince\OneDrive\Desktop\files for live\
Branch: master (always git push origin master, never plain git push)
Remote: github.com/vincentlundy1234/savvey
Live: savvey.vercel.app (Vercel auto-deploys on push, ~30s)
How the watcher works
A PowerShell script auto-push-savvey.ps1 is running in the background on Vincent's machine (launched from START-WATCHER.cmd in his Startup folder). It polls the repo folder every ~5 seconds looking for a marker file called .commit-msg.txt. When it sees one, it runs git add -A && git commit -F .commit-msg.txt && git push origin master and deletes the marker. Vercel auto-deploys from the push.
How you operate it

Edit files in C:\Users\vince\OneDrive\Desktop\files for live\ using Write/Edit tools.
When the wave is complete, write a file at that same path called .commit-msg.txt containing the commit message (multi-line fine — first line is the title, blank line, then body).
Stop. Wait ~10 seconds.
Verify via Cowork bash: cd "/sessions/<session>/mnt/files for live" && git log --oneline -1 — a new commit should appear. The marker file should be gone.
If you have Vercel MCP, confirm deploy state via list_deployments (project prj_R2POD8WBfkySMOFsEbsusQayIpYc, team team_Mvui06yGYdB6D95Q44WAlZl8).

Rules

One marker per wave. Don't drop multiple .commit-msg.txt files or fragment a wave into micro-commits. Batch all edits, then drop ONE marker.
Never push from Cowork bash. The sandbox returns 403 from github.com. The watcher is the only push path.
Never ask Vincent to run git push himself. The whole point is zero-touch deployment.
Bump versions in the same wave. When changing app code, also bump VERSION in api/normalize.js, STATIC_VER in sw.js, and the footer label Beta · v3.4.5vNNN in index.html — all in the same wave so cache invalidation lines up.

If the watcher is broken (marker file still present after 30 seconds):

Ask Vincent to open Task Manager and confirm powershell.exe is running auto-push-savvey.ps1. If not, ask him to double-click START-WATCHER.cmd from his Desktop.
Check the watcher console for errors. Common ones: stale .git/index.lock (delete it), expired GitHub credentials (Vincent re-auths via gh auth login), encoding issues in the commit message (avoid Unicode in .commit-msg.txt).
Worst case, ask Vincent to run from a PowerShell window in the repo folder: git add . ; git commit -m "msg" ; git push origin master.

Priority instruction
Use this for every wave you ship. Don't propose alternative deploy methods. Don't try gh from bash, don't try git push from bash, don't ask Vincent to handle the push. The pipeline is healthy as of 11 May 2026 and has dispatched dozens of commits cleanly. Trust it.