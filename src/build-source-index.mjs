// Rebuilds src/wowsourcedata.js — the NON-dungeon half of the Transmog Finder.
//
//   node src/build-source-index.mjs
//   node src/build-source-index.mjs --dry     (fetch and report, write nothing)
//
// Companion to build-mogindex.mjs, which covers dungeon and raid loot. This one
// fills in what the journal cannot answer:
//
//   CRAFT   itemId      -> profession + expansion tier   ("Crafted — Blacksmithing, Legion")
//   APPSET  appearanceId -> transmog set name            ("Part of Bloodfang Armor")
//
// SEPARATE FILE ON PURPOSE. The journal build is verified and working; a bad run
// here must not be able to take it down with it. Each index regenerates alone.
//
// ⚠️ WHAT IS STILL NOT COVERED, AND CANNOT BE
// World drops and vendor inventories are not published by Blizzard in any form —
// the item endpoint has no source field at all. Wowhead has them from datamining
// plus user-uploaded loot logs, rendered into HTML, with no API and terms that
// forbid scraping. So those stay a Wowhead link rather than a guess. Quest
// rewards look available (`rewards` exists on the quest endpoint) but came back
// empty on every quest tested, and quest IDs cannot be enumerated anyway.
//
// Credentials come from BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "wowsourcedata.js");
const TOKEN_URL = "https://oauth.battle.net/token";
const API = "https://us.api.blizzard.com";
const NS = "namespace=static-us&locale=en_US";
const CONCURRENCY = 8;
const DRY = process.argv.includes("--dry");

function loadCreds() {
    const id = process.env.BLIZZARD_CLIENT_ID;
    const secret = process.env.BLIZZARD_CLIENT_SECRET;
    if (!id || !secret) {
        console.error("Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET.");
        console.error("A client is free: https://develop.battle.net/access/clients");
        process.exit(1);
    }
    return { id: id.trim(), secret: secret.trim() };
}

async function getToken() {
    const { id, secret } = loadCreds();
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
        },
        body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`OAuth ${res.status} — check the client id and secret`);
    return (await res.json()).access_token;
}

/** ⚠️ A failed fetch must never read as "this thing has no source". */
async function get(path, token, tries = 4) {
    for (let i = 1; i <= tries; i++) {
        try {
            const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) return await res.json();
            if (res.status === 404) return null;
            if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            if (i === tries) throw e;
        }
        await new Promise((r) => setTimeout(r, 400 * i));
    }
    throw new Error("retries exhausted");
}

async function pool(items, fn, onTick) {
    const out = new Array(items.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
            if (onTick) onTick(++done, items.length);
        }
    }));
    return out;
}

const tick = (label) => (d, t) => {
    if (d % 100 === 0 || d === t) process.stdout.write(`\r  ${label} ${d}/${t}   `);
};

const token = await getToken();
console.log("Authenticated.\n");

/* ─────────────────────────── 1. CRAFTED ITEMS ─────────────────────────── */

console.log("── professions ──");
const profIndex = await get(`/data/wow/profession/index?${NS}`, token);
const professions = profIndex.professions ?? [];
console.log(`${professions.length} professions.`);

// Gathering professions (Mining, Herbalism, Skinning) and the secondary ones
// still list recipes, so nothing is filtered out here — a "crafted" answer for a
// Cooking recipe is just as true as one for Blacksmithing.
const profDetail = await pool(professions, (p) =>
    get(`/data/wow/profession/${p.id}?${NS}`, token).catch((e) => ({ __err: e.message, name: p.name })),
    tick("professions"));
console.log("");

const tierJobs = [];
for (const p of profDetail) {
    if (!p || p.__err) continue;
    for (const tier of p.skill_tiers ?? []) {
        tierJobs.push({ profId: p.id, profName: p.name, tierId: tier.id, tierName: tier.name });
    }
}
console.log(`${tierJobs.length} skill tiers.`);

const tierDetail = await pool(tierJobs, (j) =>
    get(`/data/wow/profession/${j.profId}/skill-tier/${j.tierId}?${NS}`, token)
        .then((d) => ({ ...j, recipes: (d?.categories ?? []).flatMap((c) => c.recipes ?? []) }))
        .catch((e) => ({ ...j, __err: e.message })),
    tick("skill tiers"));
console.log("");

const recipeJobs = [];
for (const t of tierDetail) {
    if (t.__err) continue;
    for (const r of t.recipes) recipeJobs.push({ recipeId: r.id, prof: t.profName, tier: t.tierName });
}
console.log(`${recipeJobs.length.toLocaleString()} recipes — this is the slow pass.`);

const recipeDetail = await pool(recipeJobs, (j) =>
    get(`/data/wow/recipe/${j.recipeId}?${NS}`, token)
        .then((d) => ({ ...j, item: d?.crafted_item ?? d?.alliance_crafted_item ?? d?.horde_crafted_item ?? null }))
        .catch((e) => ({ ...j, __err: e.message })),
    tick("recipes"));
console.log("");

/* ─────────────────────────── 2. APPEARANCE SETS ─────────────────────────── */

console.log("\n── transmog sets ──");
const setIndex = await get(`/data/wow/item-appearance/set/index?${NS}`, token);
const setList = setIndex.appearance_sets ?? [];
console.log(`${setList.length.toLocaleString()} named sets.`);

const setDetail = await pool(setList, (s) =>
    get(`/data/wow/item-appearance/set/${s.id}?${NS}`, token)
        .then((d) => ({ name: d?.set_name ?? s.name, appearances: (d?.appearances ?? []).map((a) => a.id) }))
        .catch((e) => ({ __err: e.message, name: s.name })),
    tick("sets"));
console.log("");

/* ─────────────────────────── 3. ASSEMBLE ─────────────────────────── */

// Profession and tier names repeat thousands of times; storing them once and
// indexing costs a few lines here and saves most of the file size.
const PROF = [];
const TIER = [];
const CRAFT = {};
const idx = (arr, v) => {
    const i = arr.indexOf(v);
    return i >= 0 ? i : arr.push(v) - 1;
};
for (const r of recipeDetail) {
    if (r.__err || !r.item?.id) continue;
    // First writer wins: a recipe repeated across expansions is reported at the
    // earliest tier we saw, which is the one a member is most likely to have.
    if (CRAFT[r.item.id]) continue;
    CRAFT[r.item.id] = [idx(PROF, r.prof), idx(TIER, r.tier)];
}

const SETS = [];
const APPSET = {};
for (const s of setDetail) {
    if (s.__err || !s.name || !s.appearances?.length) continue;
    const si = idx(SETS, s.name);
    for (const a of s.appearances) APPSET[a] ??= si;
}

const recipeErrs = recipeDetail.filter((r) => r.__err).length;
const setErrs = setDetail.filter((s) => s.__err).length;
const noItem = recipeDetail.filter((r) => !r.__err && !r.item?.id).length;

console.log(`\nCRAFT  ${Object.keys(CRAFT).length.toLocaleString()} crafted items across ${PROF.length} professions / ${TIER.length} tiers`);
console.log(`       (${noItem.toLocaleString()} recipes name no item — recrafts, toolkits and enchants)`);
console.log(`APPSET ${Object.keys(APPSET).length.toLocaleString()} appearances mapped to ${SETS.length.toLocaleString()} sets`);

if (recipeErrs || setErrs) {
    console.error(`\n⚠️  ${recipeErrs} recipe and ${setErrs} set fetches FAILED — the index would be incomplete.`);
    if (!DRY) process.exit(1);
}

if (DRY) {
    console.log("\n--dry: nothing written.");
    process.exit(0);
}

const d = new Date();
const built = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const file = `/**
 * Farm Some More — GENERATED non-dungeon source index. DO NOT HAND-EDIT.
 *
 * Built from Blizzard's profession and item-appearance endpoints on ${built}.
 * Companion to wowmogdata.js, which holds dungeon and raid loot.
 *
 * ⚠️ STILL NOT COVERED: world drops and vendors. Blizzard publishes neither —
 * the item endpoint has no source field at all. Those stay a Wowhead link rather
 * than a guess.
 *
 * REFRESH: re-run src/build-source-index.mjs, then redeploy.
 *
 * SHAPE
 *   PROF[i]              = profession name
 *   TIER[i]              = skill tier name ("Legion Blacksmithing")
 *   CRAFT[itemId]        = [profIndex, tierIndex]
 *   SETS[i]              = transmog set name
 *   APPSET[appearanceId] = setIndex
 */

export const SRC_BUILT = ${JSON.stringify(built)};

export const PROF = ${JSON.stringify(PROF)};

export const TIER = ${JSON.stringify(TIER)};

export const SETS = ${JSON.stringify(SETS)};

export const CRAFT = ${JSON.stringify(CRAFT)};

export const APPSET = ${JSON.stringify(APPSET)};
`;

writeFileSync(OUT, file, "utf8");
console.log(`\nWrote ${OUT} (${(file.length / 1024).toFixed(0)} KB).`);
console.log("Next: your app");
