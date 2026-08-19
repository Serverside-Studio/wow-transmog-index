# Changelog

All notable changes to this project are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-08-19

First public release.

### Added
- `build-journal-index.mjs` — reverse-indexes dungeon and raid loot from
  Blizzard's journal endpoints: 1,152 boss encounters across 211 instances,
  19,065 items mapped to their sources.
- `build-source-index.mjs` — the non-dungeon half: 5,868 crafted items mapped to
  profession and expansion tier, and 1,801 transmog sets mapped to 25,531
  appearances.
- `--dry` on both builders to fetch and report without writing.
- Name tables with index references, which is most of the difference between
  ~120 KB gzipped and something too large to ship in a Worker bundle.

### Notes
- Neither builder writes an index if any fetch failed. A silently incomplete
  index is worse than none, because nothing downstream can distinguish "no
  source" from "we did not manage to ask".
- World drops, vendors, quest rewards, PvP and holiday events are not covered
  because Blizzard does not publish them in any endpoint. Tools built on this
  should say so rather than implying an item is unobtainable.
- Rebuilding costs roughly 1,260 API calls for the journal pass and 22,700 for
  professions. Run it when a patch adds content, not on a schedule.

[1.0.0]: https://github.com/bryansanchez379-ui/wow-transmog-index/releases/tag/v1.0.0
