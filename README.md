# Mahjong — JFA Table

A real 4-player mahjong game: 5 sets (pong/chow) + a pair to win. No bots —
every seat is a real person, synced live. Plain HTML/CSS/JS, no build step,
using Firebase (free tier) for the realtime shared table and Vercel for
hosting.

## 1. Create a Firebase project (free)

1. Go to https://console.firebase.google.com → **Add project** → give it any
   name (e.g. `jfa-mahjong`) → you can skip Google Analytics.
2. In the left sidebar: **Build → Authentication → Get started** → under
   "Sign-in method" enable **Anonymous**. (No sign-up forms for players —
   this just gives each browser a stable identity.)
3. In the left sidebar: **Build → Firestore Database → Create database** →
   start in **production mode** → pick any region close to your players.
4. Go to **Project settings** (gear icon) → scroll to "Your apps" → click
   the **</> (Web)** icon → register an app (any nickname) → it shows you a
   `firebaseConfig` object. Copy those values into `firebase-config.js` in
   this folder, replacing the `"PASTE_ME"` placeholders.
5. Still in the Firebase console, go to **Firestore Database → Rules**,
   replace the contents with what's in `firestore.rules` in this folder,
   and click **Publish**.

That's it for Firebase — the free "Spark" plan is enough for this (Firestore
reads/writes, Anonymous Auth, both have generous free quotas).

## 2. Run it locally (optional, to test before sharing)

Any static file server works, e.g. from this folder:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Open the printed localhost URL in a few browser tabs (or incognito windows,
so each gets its own anonymous identity) to test with "4 players" yourself.

## 3. Deploy to Vercel

```bash
npm install -g vercel     # if you don't have it
cd mahjong-jfa
vercel --prod
```

Follow the prompts (first time: log in / create a Vercel account, link or
create a project). It's a plain static folder, so there's nothing to
configure — Vercel serves `index.html` as-is. You'll get a URL like
`https://your-project.vercel.app`.

Alternatively: push this folder to a GitHub repo and import it at
https://vercel.com/new — same result, plus auto-deploys on every push.

## 4. Share it with JFA

Send the Vercel URL to the other three players. Everyone who opens it:
types a display name once (saved in their browser), picks an open seat, and
once all four are in, anyone can hit **Start Game**. After a hand ends,
**Deal next hand** starts the next one with the same four seats.

Want more than one game running at once? Add `?table=anything` to the URL
— e.g. `?table=round2` — and share that link for a separate table. Players
on different `?table=` values don't see each other.

## How it's built

- `index.html` / `style.css` — the UI (lobby + table), identical visuals to
  the single-player version you've already seen, including the bigger
  tiles, click-to-inspect overview, drag-to-reorder, auto-sort-before-your-
  turn, and the confetti win celebration.
- `game.js` — the whole client: Firebase anonymous auth for identity, and
  one shared Firestore document at `tables/<tableId>` holding the entire
  game state (seats, hands, melds, discards, wall, whose turn it is). Every
  open tab subscribes to that document with `onSnapshot` and re-renders
  whenever anyone's move changes it. Dealing follows the rule you specified
  originally: each wall's front 16 tiles are cut into 4 portions of 4,
  portion 1 goes to the first player to act, portion 2 to the next, and so
  on around the table, leaving 20 tiles per wall as the shared draw pile.
- Chow is restricted to the seat right before you, same as before; pong can
  be claimed off anyone's discard; after a discard there's an 8-second
  claim window before the turn auto-advances.

## Known limitation: hand secrecy is on the honor system

This is worth understanding before you share it. The whole game state —
including every player's hand — lives in one Firestore document that all
four players' browsers can read (`firestore.rules` only checks "are you
signed in", not "is this your own hand"). The UI only ever *displays* your
own tiles, but a player who opened their browser's dev tools and inspected
the network traffic could technically read everyone's hands and the order
of the remaining wall. For a casual game among people who trust each other
that's a reasonable tradeoff — it's also exactly how the first version of
this (built as a Claude.ai artifact) worked.

**If you want this properly hidden** (so it can't be peeked at even by a
technically determined player), the fix is to move the hand-dealing and
tile-drawing logic into a trusted **Firebase Cloud Function** instead of
doing it in the browser:
- A callable function `dealTable` does the shuffle server-side, writes
  public info (seats, melds, discards, wall *count*) to the shared table
  doc, and writes each player's private hand to its own document at
  `tables/<id>/private/<uid>`.
- Firestore rules restrict `tables/<id>/private/<uid>` so only that uid can
  read it: `allow read: if request.auth.uid == uid`.
- A callable function `drawTile` does the same for draws mid-game — it's
  the only thing that ever reads the actual wall contents.

This requires upgrading the Firebase project to the **Blaze** (pay-as-you-
go) plan to use Cloud Functions — it has a generous free tier too, but
needs a credit card on file. I kept this version off that plan so you can
get it running and shared today; if you want, I can build out the Cloud
Functions version as a follow-up once this one's working for your group.
