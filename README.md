# wow-transmog-index

Build a **reverse index** of World of Warcraft item sources from Blizzard's official
Game Data API — item → the boss that drops it, the profession that crafts it, the
transmog set it belongs to.

Blizzard publishes the forward direction only. You can ask *"what does Nefarian
drop?"* all day; there is no endpoint for *"where does Bloodfang Hood come from?"*
This builds the other direction once, offline, so that lookup costs zero API calls
at request time.

```
1,152 boss encounters across 211 instances
19,065 items mapped to their sources
 5,868 crafted items mapped to profession and expansion
 1,801 transmog sets mapped to 25,531 appearances
```

The whole index gzips to about 120 KB, which is small enough to ship inside a
Cloudflare Worker bundle. That is the point: a Discord bot can answer "where does
this drop" instantly, with no database, no cache, and no request-time failure mode.

## Use it

You need a Blizzard API client — [free, takes a minute](https://develop.battle.net/access/clients).

```bash
export BLIZZARD_CLIENT_ID=...
export BLIZZARD_CLIENT_SECRET=...

node src/build-journal-index.mjs     # dungeon and raid loot  (~2 min)
node src/build-source-index.mjs      # professions and sets   (~10 min)
```

Both write ES modules into `data/`. Pass `--dry` to fetch and report without writing.

```js
import { ENC, ITEMS } from "./data/wowmogdata.js";

// where does item 16908 come from?
for (const i of ITEMS["16908"] ?? []) {
  const [boss, instance] = ENC[i];
  console.log(`${boss} — ${instance}`);   // Nefarian — Blackwing Lair
}
```

### Shape

| Export | Meaning |
|---|---|
| `ENC[i]` | `[bossName, instanceName]` |
| `ITEMS[itemId]` | `[encounterIndex, …]` — 1,966 items drop from more than one boss |
| `CRAFT[itemId]` | `[professionIndex, tierIndex]` |
| `APPSET[appearanceId]` | `setIndex` |
| `PROF` `TIER` `SETS` | name tables the indexes point into |

Names are stored once in a table and referenced by index. That is most of the
difference between 120 KB and something you would not ship in a bundle.

## What it does not cover, and why that matters

**World drops, vendors, quest rewards, PvP and holiday events are not in here,
because Blizzard does not publish them.** The item endpoint has no source field at
all. The dungeon journal covers dungeon and raid loot; professions cover crafting;
everything else is genuinely absent from the API.

Wowhead has that data — from datamining plus user-submitted loot logs, rendered
into HTML, with no API and terms that forbid scraping.

So a tool built on this index should **say so** when an item has no known source,
rather than implying the item is unobtainable. An honest "this is not a dungeon or
raid drop, here is the Wowhead page" is worth more than a confident wrong answer,
and users notice the difference quickly.

## Notes from building it

- **Rebuilding costs ~1,260 API calls** across 1,152 encounters, plus ~22,700 for
  the profession pass. Run it when a patch adds content, not on a schedule.
- **A failed fetch must never read as "no source."** Both builders retry, and
  refuse to write an index if any fetch failed — a silently incomplete index is
  worse than none, because nothing downstream can tell the difference.
- **Sets repeat by name** — Blizzard lists one per armour class, sometimes per
  gender. Collapse by name and keep the best match for the character you are
  answering for.
- **Appearances are account-wide.** A plate wearer really can be one piece from a
  cloth set. Filtering set progress by the character's armour type hides most of
  the answer.

## Licence

MIT. Built by [Sector 5 Development](https://github.com/bryansanchez379-ui) — we
build the software game communities run on.

World of Warcraft and the Battle.net API are trademarks of Blizzard Entertainment.
This project is not affiliated with or endorsed by Blizzard.
