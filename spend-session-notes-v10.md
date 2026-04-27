# Spend — full session notes
### Updated: April 2026 | Save this alongside your project brief

---

## ⚡ Latest session update — April 2026

**Where we are:**
- spend-prototype-v4.html is the latest file — this is the one to work from
- All 7 screens fully interactive: Welcome → Location → Email → Search → Scanning → Score → Buy
- "Track this price" email modal is wired to Supabase in the prototype — actually saves alerts
- Price tracker backend is fully built: SQL table, Node.js daily checker, Resend email template
- All 4 score scenarios working with animated score ring (Red 24, Amber 58, Green 91, Green 78)
- Share sheet working: WhatsApp, X, Messages, Copy

**What's still hardcoded / not yet live:**
- Product in prototype is always Sony WH-1000XM5 — not pulling from real search yet
- Prices are static scenario data — Serper not connected to prototype yet
- Scanning animation is fake — no real barcode/camera yet

**The single biggest next step:**
Connect the prototype to live Serper data so a real text search returns real prices and a real Spend Score. Everything else (barcode, camera, URL paste) comes after that.

**Files to upload at start of next session:**
- spend-project-brief.md
- spend-session-notes.md (this file)
- spend-prototype-v4.html
- spend-tracker-price-checker.js
- spend-tracker-price-alerts-table.sql
- spend-tracker-package.json

---

---

## The idea in one line

**Spend tells you what something should cost and where to get it for that price.**

A mobile-first app that gives you a Spend Score the moment you scan or search a product — and directs you to the cheapest place to buy it in the UK.

---

## The problem we're solving

The current experience of price checking in a shop:
1. See something you want
2. Open Amazon — check it
3. Go home — Google it
4. Figure out who's cheapest
5. Buy somewhere

That's 20 minutes of friction. Spend collapses it to 10 seconds.

---

## The core user journey

1. See a product in a shop (or online, or researching)
2. Open Spend — scan barcode, type name, or paste a URL
3. Get a Spend Score instantly — green/amber/red
4. See ranked UK retailers with live prices
5. Tap cheapest — buy it. Or track it and wait for the price to drop.

**The store becomes the showroom. Spend gets you the product cheaper.**

---

## Three ways to search (input modes)

### 1. Scan (default)
Point camera at barcode or product in a shop. Identifies instantly. Works everywhere.

### 2. Search
Type a product name. Works for research before buying.

### 3. Paste a link
User copies a URL from any retailer website and pastes it in. Spend extracts the product and price automatically, then finds cheaper alternatives. Covers the online shopping use case without friction.
- Works with: Amazon, Currys, John Lewis, Argos, Halfords, and most UK retailers
- Scan and Search are v1. URL paste is v1.5 (technically slightly harder — requires page fetching)

---

## Product categories covered

Not just electronics. Any physical product with a barcode and price variance:
- Electronics & appliances
- Automotive & tools (Halfords, Euro Car Parts, GSF, Amazon)
- Home & garden (B&Q, Screwfix, Wickes, Amazon)
- Sports & outdoor (Decathlon, Sports Direct, Amazon)
- Health & beauty (Boots, Superdrug, Amazon)
- Baby & kids (Smyths, Argos, Amazon)
- Pet (Pets at Home, Zooplus, Amazon)
- Kitchen & appliances

Fresh groceries handled separately (different data source needed — Trolley.co.uk API).
Start with electronics in v1. Architecture supports all categories.

---

## The Spend Score

The centrepiece of everything. A single number, 0–100, animated on arrival.

### Bands
| Score | Colour | Meaning | Message |
|---|---|---|---|
| 75–100 | 🟢 Green | Fair deal | "You're paying a fair price" |
| 40–74 | 🟡 Amber | Worth checking | "You could do better. We found it £X cheaper." |
| 0–39 | 🔴 Red | Significant overpay | "Heads up. You're paying £X more than you need to." |

### Four real scenarios designed and built
1. **Red (24/100)** — significant gap. Walk out, buy online.
2. **Amber (58/100)** — small saving. Honest: might not be worth waiting for delivery.
3. **Green best (91/100)** — you've found the best price. Buy now with confidence.
4. **Green close (78/100)** — marginally cheaper online. App tells you honestly it's barely worth it.

### Share messages per scenario
Each scenario generates a specific pre-written share message — not generic. Named retailer, exact saving, Spend Score. One tap to WhatsApp, X, Messages, or copy.

---

## Track This Price — full spec

### What it does
User taps "Track this price" after seeing a result they like but won't buy at the current price. Spend watches it and emails them when it gets cheaper.

### User flow
1. See Spend Score → tap "Track this price"
2. Email modal — pre-filled if given during sign-up
3. Confirm → "We're watching it. We'll email you the moment it drops."
4. Background: Spend checks price every 24 hours
5. Price drops → email sent immediately with new price and direct buy link

### Email template
```
Subject: Price drop — [Product name]

You asked us to watch this.

[Product name]
Was: £X · Now: £Y on [Retailer]

Your Spend Score just went from [X] → [Y]

→ Buy it now for £Y
   [direct link]

Spend · spend.app
Unsubscribe
```

### Technical pieces needed
| Piece | What | Tool | Cost |
|---|---|---|---|
| Database table | price_alerts table in Supabase | Supabase (already have) | Free |
| Save alert | Write row when user confirms tracking | Supabase API | Free |
| Daily checker | Script that re-runs Serper search for each alert | Node.js on Render.com | Free tier |
| Email sender | Send alert email when price drops | Resend.com | Free (3,000/month) |

### Supabase table structure
```
price_alerts:
  id, email, product_name, product_query,
  best_price_at_alert, best_retailer,
  created_at, last_checked, alert_sent
```

### Why this is v1 not v2
Price tracking converts casual users into loyal ones. The email moment — "it dropped, go buy it" — is the single highest-trust interaction the app can have. It's also the main reason to give an email address, which drives the sign-up mechanic. Not much extra build. Worth doing now.

### New sign-ups needed
- Resend.com — free email sending API
- Render.com — free hosting for the daily price checker script

---

## The four screens

### Screen 1 — Search
- App logo (placeholder — owl/brand coming)
- Tagline: "What should this cost?"
- Category selector — horizontal scroll chips
- Three input mode tabs: Scan / Search / Paste link
- Location detected banner (pulsing blue dot) — "You're in Currys, Oxford Street"
- Popular searches chips

### Screen 2 — Scanning
- Spinner
- Product name pill + category badge
- Retailer chips lighting up sequentially
- Progress bar

### Screen 3 — Spend Score
- Scenario switcher (prototype only)
- Animated score ring — colour changes red/amber/green per scenario
- Spectrum bar with sliding thumb
- Verdict card fades in after animation
- Product card with category badge
- Ranked retailer list
- Track this price CTA → opens email modal
- Share this Spend Score button
- Timestamp

### Screen 4 — Buy
- Back to results
- Hero card — retailer, big price, "Cheapest · historically low"
- Location context line — "You're in Currys, Oxford St — they charge £329 here"
- Big CTA button
- Three trust pills: delivery / stock / 90-day low
- Other options with +£X differences
- Share button

---

## Sign-up flow (3 screens before search)

### Screen A — Welcome
Logo placeholder, wordmark, tagline, three feature rows, one CTA.
"Get started — it's free" · "No account needed to start · Takes 30 seconds"

### Screen B — Location
Why we need it (store detection). Two benefit cards. Privacy promise.
Allow / Skip — both work, skip just loses store detection.

### Screen C — Email
Why we need it (price drop alerts + search history). Two benefit cards.
Email input. Continue / Skip — genuinely optional.
**Philosophy:** ask for email here not on sign-up screen A. They're already bought in by this point.

---

## Design principles

- **Glance test:** every screen readable in under 3 seconds without reading
- **Consumer first:** entirely on the user's side — no promoted results, no paid placement
- **Simplicity over features:** when in doubt, cut it
- **Transparency:** always show data freshness — never a price without a timestamp
- **Honesty:** if online is only marginally cheaper, say so. Don't push online every time.
- **Softness:** consistent border radius (14–16px cards, 22px pills/chips), 1px borders
- **Colour:** semantic only — green/amber/red. Not decorative.

---

## Business model

### V1 — No monetisation. Build trust first.

### V2 options (in order of preference)
1. **Retailer referral fee** — fee from retailer when Spend user buys via the app. Not affiliate bias — always show cheapest first, fee is byproduct of being useful.
2. **Premium subscription** — price drop alerts with more features, watchlist, history
3. **Retailer analytics** — aggregate pricing data sold back to brands (B2B, needs scale first)

---

## Tech stack

| Layer | Tool | Cost |
|---|---|---|
| Web prototype | Plain HTML/JS | Free |
| Price data | Serper API | Free (2,500 searches) |
| Product database | Open Food Facts / barcode lookup | Free |
| Price cache | Supabase | Free tier |
| Price alerts table | Supabase | Free tier |
| Daily price checker | Node.js on Render.com | Free tier |
| Email sending | Resend.com | Free (3,000/month) |
| Image recognition | Google Vision API | Free (1,000/month) |
| Barcode scanning | QuaggaJS | Free, open source |
| Mobile app (later) | React Native | Free |

---

## API keys in use
- **Serper:** c6f452d84cf819a5297da85154fdeb9086210a07
- **Supabase URL:** https://hbejaydvpkiowdfqhmoi.supabase.co
- **Supabase anon key:** sb_publishable_BzLm-UOTZypHVJQUZj7KRA_tqgBsadg

⚠️ Regenerate these once the prototype goes live — they've been shared in chat.

---

## UK retailers covered (v1)
Amazon UK, Currys, John Lewis, Argos, AO.com, Very, Richer Sounds, Box.co.uk, eBay UK, Halfords, Screwfix, B&Q

---

## Build plan — revised

### Phase 1 — Sign-ups needed (you do these)
- ✅ Serper API — serper.dev
- ✅ Supabase — project "spend" created
- ⬜ Resend.com — free email API (for price alerts)
- ⬜ Render.com — free hosting for daily checker script
- ⬜ Vercel — for web app deployment (optional, Replit works too)

### Phase 2 — Price engine (Claude builds)
- ✅ Price fetch from Serper for UK retailers
- ✅ Spend Score algorithm
- ✅ Price caching in Supabase
- ✅ Timestamp logic

### Phase 3 — Web prototype (built)
- ✅ All 7 screens — Welcome, Location, Email, Search, Scanning, Score, Buy
- ✅ Three input modes — Scan, Search, Paste link
- ✅ Four Spend Score scenarios — Red, Amber, Green best, Green close
- ✅ Share sheet — WhatsApp, X, Messages, Copy
- ✅ Category selector
- ✅ Location banner
- ✅ Track this price CTA + email modal

### Phase 4 — Connect to live data (next)
- Get index.html live on Replit
- Run supabase-setup.sql in Supabase SQL editor
- Test 20 real products across categories

### Phase 5 — Track This Price (build)
- Create price_alerts table in Supabase
- Wire up email modal to save alert to database
- Build daily price checker script (Node.js)
- Deploy checker to Render.com
- Set up Resend email template
- Test end to end

### Phase 6 — Camera
- Barcode scanning with QuaggaJS
- Google Vision photo recognition
- Real-world shop testing

### Phase 7 — URL paste
- Fetch and parse retailer product pages
- Extract product name and price automatically
- Handle Amazon, Currys, John Lewis, Argos, Halfords

### Later
- Full branding — owl logo, colour palette, applied throughout
- React Native mobile app
- App Store + Google Play
- Company registration + legal

---

## Branding — pending
- Owl character confirmed — wise, sharp-eyed, sees what others miss
- Logo placeholder in prototype — black square with "S"
- Will apply full branding once logo delivered
- Colour palette TBD — mood: trustworthy, sharp, playful

---

## Files built
| File | What it is |
|---|---|
| spend-project-brief.md | Paste at start of every Claude session |
| spend-session-notes.md | This file — full record of everything |
| spend-app/index.html | Working app — real Serper data, Spend Score, Supabase cache |
| spend-app/supabase-setup.sql | Run in Supabase SQL editor |
| spend-prototype-v4.html | Full clickable prototype — 7 screens, all features |

---

## How to start next session
Open new Claude chat. Paste project brief. Then:
> "Here are my API keys: Serper: xxx, Supabase URL: xxx, Supabase key: xxx. Today we're working on: [what you want to do]."

---

## Key decisions locked
- Three input modes: Scan / Search / Paste link ✅
- URL paste is v1.5, not v1 ✅
- All product categories in scope (not just electronics) ✅
- Track This Price is v1 not v2 ✅
- Email asking via Resend ✅
- Daily price checker on Render ✅
- No monetisation until user base established ✅
- Owl brand character — pending logo ✅
- Name: Spend ✅

---

## The idea in one line

**Spend tells you what something should cost and where to get it for that price.**

A mobile-first app that gives you a Spend Score the moment you scan or search a product — and directs you to the cheapest place to buy it in the UK.

---

## The problem we're solving

The current experience of price checking in a shop:
1. See something you want
2. Open Amazon — check it
3. Go home — Google it
4. Figure out who's cheapest
5. Buy somewhere

That's 20 minutes of friction. Spend collapses it to 10 seconds.

---

## The core user journey

1. See a product in a shop
2. Open Spend — scan barcode or type name
3. Get a Spend Score instantly — green/amber/red
4. See ranked UK retailers with live prices
5. Tap cheapest — buy it

**The store becomes the showroom. Spend gets you the product cheaper.**

---

## The Spend Score

The centrepiece of everything. A single number, 0–100, animated on arrival.

### Bands
| Score | Colour | Meaning | Message |
|---|---|---|---|
| 75–100 | 🟢 Green | Fair deal | "You're paying a fair price" |
| 40–74 | 🟡 Amber | Worth checking | "You could do better. We found it £X cheaper." |
| 0–39 | 🔴 Red | Significant overpay | "Heads up. You're paying £X more than you need to." |

### How it's calculated
- Best live price across UK retailers right now
- Gap between where user is vs that best price
- Price history context (v2 — not in v1)

### The animation
- Number races up fast — overshoots to ~3x the final score
- Bounces back down with a spring settle — lands hard on the real number
- Circular arc does the same journey
- Spectrum bar (red → amber → green) with a thumb that slides to the score position
- Verdict card fades in after the number lands

### Why "Spend Score" not "Rip-off score"
- Branded — it's ours, nobody else owns it
- Non-accusatory — avoids legal risk of calling retailers rip-offs
- Memorable — people will quote it: "what's the Spend Score on this?"

---

## The four screens

### Screen 1 — Search
- App name (Spend) + tagline "What should this cost?"
- Text input + Check button
- Popular searches chips below
- Dead simple — open it and you're already on the action

### Screen 2 — Scanning
- Spinner animation
- Product name shown as pill
- Retailer chips light up sequentially as each is checked
- Progress bar
- "Checking across UK retailers" — sets expectation of under 5 seconds

### Screen 3 — Spend Score
- Big animated score reveal (the money moment)
- Spectrum bar showing where score sits (Overpaying → Check around → Fair deal)
- Verdict card fades in: headline + £ saving vs current location
- Product name and one-line description
- Ranked retailer list — cheapest first, green border on best
- "prices checked just now" timestamp — trust signal
- Tap any retailer to go to Screen 4

### Screen 4 — Buy
- Back chevron → results
- Hero card: retailer name, big price, "Cheapest · historically low price"
- Big black CTA button: "Go to [Retailer] →"
- Three trust pills: Free delivery / In stock / 90-day low
- Other options listed below with +£X difference
- Share this Spend Score button

---

## Design principles

- **Glance test:** every screen readable in under 3 seconds without reading
- **Consumer first:** entirely on the user's side — no promoted results, no paid placement
- **Simplicity over features:** when in doubt, cut it
- **Transparency:** always show data freshness — never a price without a timestamp
- **Softness:** consistent border radius (14–16px cards, 22px pills/chips), 1px borders not 0.5px for warmth
- **Colour:** semantic only — green = good, amber = check, red = overpaying. Not decorative.

---

## What already exists (competitors)

- **Google Lens** — closest competitor, but buried in Google's ecosystem, not a focused shopping tool
- **ShopSavvy** — barcode + photo search, price comparison, no AI context layer
- **Amazon Camera Search** — walled garden, Amazon only
- **CamFind** — visual search, no price comparison
- **Product Finder (App Store)** — does photo search + price compare but niche and unknown

**The gap Spend owns:**
- The Spend Score framing — nobody gives a verdict, just data
- Location-aware UK retail preference — underdeveloped everywhere
- Speed and simplicity — designed for the shop floor moment
- Entirely on the consumer's side — no affiliate bias in v1

---

## Business model (decided)

### V1 — No monetisation
Build the product. Earn trust. Revenue is a v2 problem.

### V2 options (in order of preference)
1. **Retailer fee on purchase** — take a cut from the retailer when a user buys via Spend (not affiliate in the traditional sense — fee from cheapest retailer, keeps us on consumer's side)
2. **Premium subscription** — price drop alerts, watchlist, background tracking
3. **Retailer listing fees** — promoted placement for nearby stores (footfall value)

### What we decided NOT to do in v1
- No affiliate links (makes it look like we're not on the consumer's side)
- No retailer commercial relationships
- No paid placement

---

## Tech stack

| Layer | Tool | Cost |
|---|---|---|
| Web prototype | Plain HTML/JS | Free |
| Price data | Serper API (Google Shopping) | Free tier — 2,500 searches |
| Database / cache | Supabase | Free tier |
| Deployment | Replit or Vercel | Free tier |
| Image recognition | Google Vision API | Free tier — 1,000/month |
| Barcode scanning | QuaggaJS or ZXing | Free, open source |
| Mobile app (later) | React Native | Free |

### API keys in use
- **Serper:** c6f452d84cf819a5297da85154fdeb9086210a07
- **Supabase URL:** https://hbejaydvpkiowdfqhmoi.supabase.co
- **Supabase anon key:** sb_publishable_BzLm-UOTZypHVJQUZj7KRA_tqgBsadg

⚠️ **Regenerate these keys once the prototype is live** — they've been shared in chat.

---

## UK retailers covered (v1)

Amazon UK, Currys, John Lewis, Argos, AO.com, Very, Richer Sounds, Box.co.uk, eBay UK, Costco UK

**Category: Electronics and appliances first**
- Highest price variance
- Highest average order value
- Most valuable moment for the app (biggest savings)

---

## Build plan

### Phase 1 — Sign-ups (done)
- ✅ Serper API — serper.dev
- ✅ Supabase — project "spend" created
- ⬜ Vercel — for deployment (optional, Replit works too)
- ⬜ Google Vision API — for photo recognition (v1.5, not needed yet)

### Phase 2 — Price engine (Claude builds)
- Price fetch from Serper for UK retailers
- Spend Score algorithm (0–100, green/amber/red)
- Price caching in Supabase with hourly refresh
- Timestamp logic ("checked X minutes ago")

### Phase 3 — Web prototype live (done in session)
- ✅ index.html — working app with real Serper data
- ✅ supabase-setup.sql — run this in Supabase SQL editor to create cache table
- ✅ spend-prototype-v3.html — fully clickable design prototype, all 4 screens

### Phase 4 — Connect prototype to live data
- Get index.html live on Replit
- Run supabase-setup.sql
- Test 20 real products

### Phase 5 — Camera (coming)
- Barcode scanning
- Google Vision photo recognition
- Real-world shop testing

### Later
- Full branding applied to prototype
- React Native mobile app
- App Store + Google Play submission
- Company registration + legal

---

## Branding — in progress

### Status
Working on it. Will share logo when ready.

### The owl idea
An owl character — wise, sharp-eyed, sees what others miss. Fits the app's personality perfectly.

**Ideas for how to use it:**
- App icon — clean, distinctive, recognisable small
- Score screen character — owl looks pleased on green, alarmed on red
- Scanning animation — owl eyes scanning left to right instead of a spinner (memorable)
- Easter egg — owl winks on a great deal, feathers ruffled on a terrible one
- The character that "spotted" the saving for you

### Name — keeping "Spend"
Strong, one word, slightly counterintuitive, sticks.

**Alternatives considered (in case):**
Scout, Wise, Perch, Talon, Hoot — some play into the owl too.

### What to bring back when logo is ready
- Logo file — SVG or PNG, transparent background preferred
- Any colour palette or mood words (e.g. "trustworthy", "sharp", "playful")
- Whether owl is the logo itself or a character alongside the wordmark

### What Claude will do when branding arrives
- Drop logo into prototype header
- Apply colour palette throughout all 4 screens
- Add owl character to score screen
- Show full branded version in one go

---

## Files built this session

| File | What it is |
|---|---|
| spend-project-brief.md | Paste this at the start of every new Claude session |
| spend-app/index.html | Working app — real Serper price data, Spend Score, Supabase cache |
| spend-app/supabase-setup.sql | Run in Supabase SQL editor to create price_cache table |
| spend-prototype-v3.html | Clickable design prototype — all 4 screens, animated score |

---

## How to start the next session

Open a new Claude chat. Paste the project brief (spend-project-brief.md). Then say:

> "Here are my API keys: Serper: xxx, Supabase URL: xxx, Supabase key: xxx. Today we're working on: [what you want to do]."

---

## Key decisions locked in

- Start with web prototype, not native app ✅
- Barcode scan before image recognition ✅
- Use Serper (not PriceAPI) for price data — free and sufficient for v1 ✅
- Cache prices hourly — show timestamp honestly ✅
- No affiliate links or retailer relationships in v1 ✅
- Electronics category only in v1 ✅
- UK only in v1 ✅
- Revenue model is a v2 problem ✅
- Owl as brand character — pending logo ✅
- Name: Spend ✅

---

## Things still to decide

- Exact green/amber/red score band percentages (need real data to calibrate)
- Whether owl is in the logo or alongside it
- Final colour palette
- Premium tier pricing (v2 problem — don't decide yet)
- Which scraping/price service to use at scale beyond Serper free tier

---

## ⚡ Session update — April 2026 (continued)

**Branding decisions locked:**
- App name: **Savvey** (double-v, not Savey)
- Logo: **Green S badge** — clean, scalable, no owl in the logo
- The owl lives *inside* the app as a character (scanning, marketing, email alerts) but is NOT the logo
- S badge: forest green gradient, rounded square, white S, subtle highlight — works at all sizes
- Tagline: **spend smart.** — red full stop is the only red element in the logo
- Score name: **Savvey Score** — not Savey Score (was being misspelled)

**Score messaging locked:**
- 🟢 75–100: **Right price** — "You're at the best available price. Buy with confidence."
- 🟡 40–74: **Check around** — "A saving is available. Reasonable if you need it today."
- 🔴 0–39: **Overpaying** — "You could save £X. [Retailer] has it for £Y."

**Category tabs — now working as proper tabs:**
- Each category chip opens its own panel below
- Each panel has: ranked trending list + Featured slot at top
- Featured slot = future ad/partnership unit (currently shows contextual partner e.g. Halfords in Automotive)
- Clearly labelled "Featured" — doesn't break consumer trust
- Revenue model: flat weekly fee per category slot from relevant retailers/brands

**Scanner screen added (screen 5):**
- Dark camera viewfinder, animated scan beam, corner brackets
- Auto lock-on after 2 seconds → detected product card slides up
- "Check price →" button advances to spinner
- Fallback: "Type product name instead"

**Revenue model (save for v2+):**
1. Amazon affiliate links — trivial to add (`?tag=savvey-21`)
2. Awin network — covers Currys, JL, Argos, AO in one account
3. Category featured slots — flat fee from retailers
4. Savvey Plus subscription — price history, bigger watchlist
5. Price data API — sell data to third parties (v3)

**Current prototype: v9**
- File: savvey-prototype-v9.html
- All 8 screens working: Welcome → Location → Email → Search → Scanner → Scanning → Savvey Score → Buy
- Category tabs fully functional with per-category trending panels
- Supabase price alert saving wired up

**Next step: deploy to Vercel for real-device testing**

---

## ⚡ v10 — Launch version — April 2026

**v10 is the clean launch file. All of the below is done:**

- All 9 screens working and logically consistent
- Score messaging: Right price / Check around / Overpaying (consistent everywhere)
- Savvey Score spelled correctly throughout
- URL paste with live retailer detection (Amazon, Currys, JL, Argos, Halfords, AO, Very, Boots, Tesco)
- Price interstitial: "What are you paying?" before any score is shown
- Best-price-only mode when user skips price entry
- Scanner screen: animated viewfinder, barcode lock-on, detected product card
- Category tabs: 8 categories, each with own trending panel and Featured slot
- Dynamic timestamp on score screen
- Product meta updates per scenario
- Email validation (proper regex, red border on invalid)
- Benefit ticks on email screen are decorative SVGs (not fake checkboxes)
- Buy button links to real Amazon product page
- OG meta tags and theme-color for sharing/PWA
- Green S logo consistent across all screen sizes

**Files to bring to next session:**
- savvey-prototype-v10.html ← the one to deploy
- spend-session-notes.md (this file)
- spend-project-brief.md
- spend-tracker-price-checker.js
- spend-tracker-price-alerts-table.sql
- spend-tracker-package.json

**Immediate next steps:**
1. Deploy v10 to Vercel (30 mins, free account)
2. Test on real phone — share the URL
3. Connect Serper to text search (2–3 hrs)
4. Add Amazon affiliate tag to buy links (`?tag=savvey-21`)

**On the backburner (do when ready):**
- Google Lens / Vision API for photo identification
- Price history 90-day chart
- Savvey Plus subscription
- React Native app
