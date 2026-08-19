// Rebuilds src/wowmogdata.js — the transmog drop index behind the Transmog
// Finder panel in Farm Some More.
//
//   node src/build-journal-index.mjs
//   node src/build-journal-index.mjs --dry     (fetch and report, write nothing)
//
// WHEN TO RUN THIS: after a patch adds dungeons, raids or bosses. Nothing else
// needs touching afterwards except `your app`.
//
// WHY AN OFFLINE BUILD AND NOT A LIVE FETCH
// -----------------------------------------
// The question "where does this drop" needs a REVERSE index (item -> boss), and
// Blizzard only publishes the forward direction (boss -> items). Building it
// costs ~1,260 requests. That does not fit in a 3-second interaction, and the
// Worker's five cron slots are ALL already in use, so there is nowhere to
// schedule a rebuild either. Baked in, a lookup costs zero API calls and has no
// request-time failure mode at all.
//
// Credentials come from BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "wowmogdata.js");
const TOKEN_URL = "https://oauth.battle.net/token";
const API = "https://us.api.blizzard.com";
const NS = "static-us";
const CONCURRENCY = 8;          // polite; the whole run is a couple of minutes
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

/**
 * One GET, with retries.
 *
 * ⚠️ A FAILED FETCH MUST NOT LOOK LIKE AN EMPTY BOSS. Silently treating an error
 * as "this boss drops nothing" would quietly shrink the index, and the panel
 * would then confidently tell a member their item is not a dungeon drop. So this
 * retries, and a final failure is counted and reported — never swallowed.
 */
async function get(url, token, tries = 4) {
    for (let i = 1; i <= tries; i++) {
        try {
            const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) return await res.json();
            if (res.status === 404) return null;                 // genuinely gone
            if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            if (i === tries) throw e;
        }
        await new Promise((r) => setTimeout(r, 400 * i));        // back off
    }
    throw new Error("retries exhausted");
}

/** Run `fn` over `items` with a fixed number of requests in flight. */
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
    if (d % 25 === 0 || d === t) process.stdout.write(`\r  ${label} ${d}/${t}`);
};

const token = await getToken();
console.log("Authenticated.");

const index = await get(`${API}/data/wow/journal-instance/index?namespace=${NS}&locale=en_US`, token);
const instances = index.instances ?? [];
console.log(`${instances.length} instances in the journal.`);

// Instance -> its encounter list. The instance record carries the boss names but
// NOT their loot, so this pass only builds the work list for the next one.
const instDetail = await pool(instances, (inst) =>
    get(`${API}/data/wow/journal-instance/${inst.id}?namespace=${NS}&locale=en_US`, token)
        .catch((e) => ({ __err: e.message, name: inst.name })),
    tick("instances"));
console.log("");

const instErrs = instDetail.filter((d) => d?.__err);
const work = [];
for (const inst of instDetail) {
    if (!inst || inst.__err) continue;
    for (const enc of inst.encounters ?? []) {
        work.push({ encId: enc.id, boss: enc.name, instance: inst.name });
    }
}
console.log(`${work.length} encounters to read.`);

// Encounter -> its items. This is the pass that costs the real time.
const encDetail = await pool(work, (w) =>
    get(`${API}/data/wow/journal-encounter/${w.encId}?namespace=${NS}&locale=en_US`, token)
        .then((d) => ({ ...w, items: d?.items ?? [] }))
        .catch((e) => ({ ...w, __err: e.message })),
    tick("encounters"));
console.log("");

const encErrs = encDetail.filter((e) => e.__err);

const ENC = [];
const ITEMS = {};
for (const e of encDetail) {
    if (e.__err) continue;
    const i = ENC.length;
    ENC.push([e.boss, e.instance]);
    for (const it of e.items) {
        const id = it.item?.id;
        if (!id) continue;
        (ITEMS[id] ??= []).push(i);
    }
}

const multi = Object.values(ITEMS).filter((v) => v.length > 1).length;
const instanceCount = new Set(ENC.map((x) => x[1])).size;
console.log(`\nENC   ${ENC.length} encounters across ${instanceCount} instances`);
console.log(`ITEMS ${Object.keys(ITEMS).length} distinct items (${multi} drop from more than one boss)`);

if (instErrs.length || encErrs.length) {
    // Loud on purpose — a partial index is the one failure mode that looks like
    // success right up until a member asks about the boss that went missing.
    console.error(`\n⚠️  ${instErrs.length} instance and ${encErrs.length} encounter fetches FAILED.`);
    encErrs.slice(0, 10).forEach((e) => console.error(`   ${e.instance} / ${e.boss}: ${e.__err}`));
    console.error("   The index would be INCOMPLETE. Re-run before deploying.");
    if (!DRY) process.exit(1);
}

if (DRY) {
    console.log("\n--dry: nothing written.");
    process.exit(0);
}

// Local date, NOT toISOString() — that is UTC, and it stamped tomorrow's date
// on a build run on a US evening. The footer is read by members, not by servers.
const d = new Date();
const built = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const calls = (instances.length + work.length + 1).toLocaleString();

// ⚠️ SERIALISE WITH JSON.stringify, NOT a hand-rolled join. The first build of
// this index was generated in PowerShell, whose ConvertTo-Json wrapped every
// pair as {"value":[...],"Count":2} — the file parsed, imported and looked
// perfect, and every lookup came back "undefined — undefined".
const file = `/**
 * Farm Some More — GENERATED transmog drop index. DO NOT HAND-EDIT.
 *
 * Built from Blizzard's official Game Data journal endpoints
 * (journal-instance -> journal-encounter -> items) on ${built}.
 *
 * WHY THE DATA IS BAKED IN RATHER THAN FETCHED
 * --------------------------------------------
 * Answering "where does this drop" needs a REVERSE index (item -> boss), and
 * Blizzard only exposes the forward direction (boss -> items). Building it costs
 * ~${calls} API calls across ${ENC.length} encounters — far too slow for one
 * interaction, and the Worker's five cron slots are ALL already in use, so there
 * is nowhere to schedule a rebuild. Baking it in makes a lookup cost zero API
 * calls and removes every request-time failure mode.
 *
 * REFRESH: re-run src/build-journal-index.mjs when a patch adds instances, then
 * redeploy. Nothing else needs touching.
 *
 * SHAPE
 *   ENC[i]        = [bossName, instanceName]
 *   ITEMS[itemId] = [encounterIndex, ...]   (${multi.toLocaleString()} items drop from >1 boss)
 */

export const MOG_BUILT = ${JSON.stringify(built)};

export const ENC = ${JSON.stringify(ENC)};

export const ITEMS = ${JSON.stringify(ITEMS)};
`;

writeFileSync(OUT, file, "utf8");
console.log(`\nWrote ${OUT} (${(file.length / 1024).toFixed(0)} KB).`);
console.log("Next: your app");
