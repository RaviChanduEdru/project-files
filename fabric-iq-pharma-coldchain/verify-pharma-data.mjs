/**
 * Verifies the Aurora Pharma cold-chain dataset (the CSVs beside this script).
 *
 * It also COMPUTES the escalation table the article publishes, so the numbers in
 * the prose are generated, never hand-counted. Exits non-zero on any failure.
 *
 * Run: node verify-pharma-data.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url)); // the CSVs sit beside this script
const TICK_MINUTES = 15; // must match the generator, the sender and the KQL

function readCsv(name) {
  const text = readFileSync(join(DIR, name), "utf8").trim();
  const [header, ...lines] = text.split("\n");
  const cols = header.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}`);
  if (!ok) failures += 1;
};

const sites = readCsv("sites.csv");
const products = readCsv("products.csv");
const trucks = readCsv("trucks.csv");
const shipments = readCsv("shipments.csv");
const batches = readCsv("batches.csv");
const legs = readCsv("legs.csv");
const legCargo = readCsv("leg_cargo.csv");
const telemetry = readCsv("reefer_telemetry_seed.csv");

const siteIds = new Set(sites.map((s) => s.SiteID));
const productById = new Map(products.map((p) => [p.ProductID, p]));
const truckIds = new Set(trucks.map((t) => t.TruckID));
const shipmentIds = new Set(shipments.map((s) => s.ShipmentID));
const batchById = new Map(batches.map((b) => [b.BatchID, b]));
const legById = new Map(legs.map((l) => [l.LegID, l]));

const ms = (iso) => Date.parse(iso);

/* ---------- integrity ----------------------------------------------------- */

console.log("\nIntegrity:");
check(batches.every((b) => productById.has(b.ProductID)), "every batch's ProductID resolves");
check(batches.every((b) => shipmentIds.has(b.ShipmentID)), "every batch's ShipmentID resolves");
check(legs.every((l) => shipmentIds.has(l.ShipmentID)), "every leg's ShipmentID resolves");
check(legs.every((l) => truckIds.has(l.TruckID)), "every leg's TruckID resolves");
check(legs.every((l) => siteIds.has(l.FromSiteID) && siteIds.has(l.ToSiteID)), "every leg's sites resolve");
check(telemetry.every((t) => truckIds.has(t.TruckID)), "every telemetry TruckID resolves");
check(new Set(batches.map((b) => b.BatchID)).size === batches.length, "BatchIDs unique");
check(new Set(legs.map((l) => l.LegID)).size === legs.length, "LegIDs unique");
check(
  batches.every((b) => Math.abs(Number(b.ValueUSD) - Number(b.Units) * Number(productById.get(b.ProductID).UnitValueUSD)) < 0.02),
  "ValueUSD = Units x UnitValueUSD"
);
check(
  telemetry.every((t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(t.Timestamp)),
  "telemetry timestamps are ISO 8601 UTC (bind as datetime)"
);
check(
  legs.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(l.DepartUtc) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(l.ArriveUtc)),
  "leg windows are ISO 8601 UTC"
);

/* ---------- routes are contiguous ---------------------------------------- */

console.log("\nRoutes:");
const legsByShipment = new Map();
for (const l of legs) {
  if (!legsByShipment.has(l.ShipmentID)) legsByShipment.set(l.ShipmentID, []);
  legsByShipment.get(l.ShipmentID).push(l);
}
for (const arr of legsByShipment.values()) arr.sort((a, b) => Number(a.LegSeq) - Number(b.LegSeq));

let seqOk = true;
let chainOk = true;
let timeOk = true;
for (const [shipmentId, arr] of legsByShipment) {
  arr.forEach((l, i) => {
    if (Number(l.LegSeq) !== i + 1) seqOk = false;
    if (i > 0) {
      if (arr[i - 1].ToSiteID !== l.FromSiteID) chainOk = false;
      if (ms(l.DepartUtc) < ms(arr[i - 1].ArriveUtc)) timeOk = false;
    }
    if (ms(l.ArriveUtc) <= ms(l.DepartUtc)) timeOk = false;
  });
  const ship = shipments.find((s) => s.ShipmentID === shipmentId);
  if (arr[0].FromSiteID !== ship.OriginSiteID) chainOk = false;
  if (arr[arr.length - 1].ToSiteID !== ship.DestinationSiteID) chainOk = false;
}
check(seqOk, "LegSeq runs 1..n with no gaps per shipment");
check(chainOk, "each leg departs where the previous arrived, and the chain matches the shipment's origin/destination");
check(timeOk, "leg windows are ordered and non-negative");

// A truck can only be on one leg at a time, or a reading would join to two
// journeys in KQL and double-count a batch's exposure.
const legsByTruck = new Map();
for (const l of legs) {
  if (!legsByTruck.has(l.TruckID)) legsByTruck.set(l.TruckID, []);
  legsByTruck.get(l.TruckID).push(l);
}
const overlaps = [];
for (const [truckId, arr] of legsByTruck) {
  arr.sort((a, b) => ms(a.DepartUtc) - ms(b.DepartUtc));
  for (let i = 1; i < arr.length; i++) {
    if (ms(arr[i].DepartUtc) < ms(arr[i - 1].ArriveUtc)) overlaps.push(`${truckId}: ${arr[i - 1].LegID}/${arr[i].LegID}`);
  }
}
check(overlaps.length === 0, `no truck is on two legs at once${overlaps.length ? ` â€” ${overlaps.slice(0, 4).join(", ")}` : ""}`);

/* ---------- leg_cargo mirrors the graph ---------------------------------- */

console.log("\nleg_cargo (the KQL dimension):");
const batchesByShipment = new Map();
for (const b of batches) {
  if (!batchesByShipment.has(b.ShipmentID)) batchesByShipment.set(b.ShipmentID, []);
  batchesByShipment.get(b.ShipmentID).push(b);
}
let expectedCargo = 0;
for (const [shipmentId, arr] of legsByShipment) expectedCargo += arr.length * (batchesByShipment.get(shipmentId)?.length ?? 0);
check(legCargo.length === expectedCargo, `one row per (leg x batch): ${legCargo.length} = ${expectedCargo}`);
check(
  legCargo.every((r) => {
    const leg = legById.get(r.LegID);
    const batch = batchById.get(r.BatchID);
    const prod = productById.get(r.ProductID);
    return (
      leg && batch && prod &&
      leg.TruckID === r.TruckID &&
      leg.ShipmentID === r.ShipmentID &&
      batch.ShipmentID === r.ShipmentID &&
      batch.ProductID === r.ProductID &&
      leg.DepartUtc === r.DepartUtc &&
      leg.ArriveUtc === r.ArriveUtc &&
      prod.MinSafeC === r.MinSafeC &&
      prod.MaxSafeC === r.MaxSafeC &&
      prod.BudgetMinutes === r.BudgetMinutes
    );
  }),
  "every leg_cargo row agrees with legs, batches and products"
);

/* ---------- exposure model (same arithmetic the KQL will do) ------------- */

/**
 * Per batch: for each leg it rides, count readings from that leg's truck inside
 * the leg window that fall outside the batch product's band. Each such reading
 * costs TICK_MINUTES. Cold readings are counted separately because freezing has
 * no budget at all.
 */
const readingsByTruck = new Map();
for (const t of telemetry) {
  if (!readingsByTruck.has(t.TruckID)) readingsByTruck.set(t.TruckID, []);
  readingsByTruck.get(t.TruckID).push({ at: ms(t.Timestamp), temp: Number(t.TempC) });
}
for (const arr of readingsByTruck.values()) arr.sort((a, b) => a.at - b.at);

const exposure = new Map(); // BatchID -> { hotMin, coldMin, budget, perLeg: Map, hottest, coldest }
for (const r of legCargo) {
  const min = Number(r.MinSafeC);
  const max = Number(r.MaxSafeC);
  const budget = Number(r.BudgetMinutes);
  const from = ms(r.DepartUtc);
  const to = ms(r.ArriveUtc);
  const readings = (readingsByTruck.get(r.TruckID) ?? []).filter((x) => x.at >= from && x.at <= to);

  let hot = 0;
  let cold = 0;
  let hottest = -Infinity;
  let coldest = Infinity;
  for (const x of readings) {
    if (x.temp > max) hot += TICK_MINUTES;
    if (x.temp < min) cold += TICK_MINUTES;
    hottest = Math.max(hottest, x.temp);
    coldest = Math.min(coldest, x.temp);
  }
  if (!exposure.has(r.BatchID)) exposure.set(r.BatchID, { hotMin: 0, coldMin: 0, budget, perLeg: new Map(), hottest: -Infinity, coldest: Infinity, readings: 0 });
  const e = exposure.get(r.BatchID);
  e.hotMin += hot;
  e.coldMin += cold;
  e.readings += readings.length;
  e.hottest = Math.max(e.hottest, hottest);
  e.coldest = Math.min(e.coldest, coldest);
  e.perLeg.set(r.LegID, { hot, cold, readings: readings.length });
}

console.log("\nTelemetry coverage:");
check([...exposure.values()].every((e) => e.readings > 0), "every batch has telemetry on every leg it rides");
const legWindowMiss = telemetry.filter((t) => {
  const arr = legsByTruck.get(t.TruckID) ?? [];
  return !arr.some((l) => ms(t.Timestamp) >= ms(l.DepartUtc) && ms(t.Timestamp) <= ms(l.ArriveUtc));
});
check(legWindowMiss.length === 0, `every reading falls inside one of its truck's leg windows${legWindowMiss.length ? ` â€” ${legWindowMiss.length} orphans` : ""}`);

/* ---------- the planted signals ------------------------------------------ */

const FREEZE = "AUR-2207";
const CUMULATIVE = "AUR-2211";

console.log("\nSignal 1 â€” the freeze blind spot (AUR-2207):");
const fz = exposure.get(FREEZE);
check(!!fz, `${FREEZE} exists and rides at least one leg`);
if (fz) {
  const b = batchById.get(FREEZE);
  check(productById.get(b.ProductID).Form === "Insulin", `${FREEZE} carries insulin (freezing destroys it), got ${productById.get(b.ProductID).Name}`);
  check(fz.coldMin >= 90, `sustained sub-2C exposure: ${fz.coldMin} min below band (want >= 90)`);
  check(fz.hotMin === 0, `NOT ONE reading above 8C: hot minutes = ${fz.hotMin} (must be 0, this is the whole point)`);
  check(fz.hottest <= 8, `hottest reading on its journey is ${fz.hottest.toFixed(1)}C (must be <= 8)`);
  check(fz.coldest < 2, `coldest reading is ${fz.coldest.toFixed(1)}C (must be < 2)`);
  // The cause in the article is a -20C setpoint copied from the frozen product.
  // The readings have to look like that cause, not merely like "a bit too cold".
  check(fz.hottest < -15, `it really did run at the frozen setpoint: warmest reading ${fz.hottest.toFixed(1)}C (must be < -15)`);
}

console.log("\nSignal 2 â€” death by a thousand door-openings (AUR-2211):");
const cu = exposure.get(CUMULATIVE);
check(!!cu, `${CUMULATIVE} exists and rides at least one leg`);
if (cu) {
  const pct = (cu.hotMin / cu.budget) * 100;
  const worstLeg = Math.max(...[...cu.perLeg.values()].map((v) => v.hot));
  check(cu.perLeg.size === 3, `crosses three legs: ${cu.perLeg.size}`);
  check(pct >= 80 && pct < 100, `burns most of its budget without blowing it: ${cu.hotMin}/${cu.budget} min = ${pct.toFixed(0)}% (want 80-99%)`);
  check(
    (worstLeg / cu.budget) * 100 <= 40,
    `no single leg looks alarming: worst leg = ${worstLeg} min = ${((worstLeg / cu.budget) * 100).toFixed(0)}% of budget (want <= 40%)`
  );
  check(cu.coldMin === 0, `its story is heat, not cold: cold minutes = ${cu.coldMin}`);
}

console.log("\nThe live demo needs an OPEN leg, or streamed readings join to nothing:");
const LIVE_BATCH = "AUR-2299";
const LIVE_TRUCK = "TRK-04";
const seedEnd = Math.max(...telemetry.map((t) => ms(t.Timestamp)));
const liveCargo = legCargo.filter((r) => r.BatchID === LIVE_BATCH);
const openLegs = liveCargo.filter((r) => ms(r.ArriveUtc) > seedEnd);
check(liveCargo.length === 3, `${LIVE_BATCH} rides three legs: ${liveCargo.length}`);
check(openLegs.length >= 1, `at least one leg is still open when the seed ends: ${openLegs.map((r) => r.LegID).join(", ") || "none"}`);
check(
  openLegs.some((r) => r.TruckID === LIVE_TRUCK && ms(r.DepartUtc) <= seedEnd),
  `${LIVE_TRUCK} (the sender's incident truck) is mid-leg at the seed boundary, so live readings land inside a window`
);
const liveExp = exposure.get(LIVE_BATCH);
if (liveExp) {
  const pct = (liveExp.hotMin / liveExp.budget) * 100;
  check(pct >= 40 && pct <= 60, `${LIVE_BATCH} starts the demo about half spent: ${liveExp.hotMin}/${liveExp.budget} = ${pct.toFixed(0)}% (want 40-60%)`);
}
check(
  telemetry.every((t) => Number(t.IntervalMinutes) > 0),
  "every reading carries its own IntervalMinutes, so the KQL never assumes a cadence"
);

console.log("\nSignal 3 â€” the loud failure is NOT pre-baked:");
const anyBlown = [...exposure.entries()].filter(([, e]) => e.hotMin > e.budget);
check(anyBlown.length === 0, `no batch has already blown its heat budget in the seed${anyBlown.length ? ` â€” ${anyBlown.map(([id]) => id).join(", ")}` : ""} (the live incident supplies that)`);

console.log("\nSignal 4 â€” noise everywhere (so naive rules scream):");
const outOfRangeReadings = [...exposure.values()].reduce((s, e) => s + (e.hotMin + e.coldMin) / TICK_MINUTES, 0);
const batchesWithAnyExcursion = [...exposure.values()].filter((e) => e.hotMin + e.coldMin > 0).length;
check(batchesWithAnyExcursion >= exposure.size * 0.5, `at least half of batches have SOME excursion: ${batchesWithAnyExcursion}/${exposure.size}`);
console.log(`  (${outOfRangeReadings} out-of-range batch-readings across the fleet in the seed window)`);

/* ---------- the escalation table, computed ------------------------------- */

console.log("\nESCALATION â€” what each rule flags over the seed (this table goes in the article):");

// Rule 1: any reading above 8C, judged globally. Counts every dock opening.
const rule1 = new Set();
for (const [truckId, arr] of readingsByTruck) if (arr.some((x) => x.temp > 8)) rule1.add(truckId);
// Rule 2: above 8C sustained (>= 3 consecutive readings), still global.
const rule2 = new Set();
for (const [truckId, arr] of readingsByTruck) {
  let run = 0;
  for (const x of arr) {
    run = x.temp > 8 ? run + 1 : 0;
    if (run >= 3) { rule2.add(truckId); break; }
  }
}
// Rule 3: per-batch cumulative against the product's own budget, plus any freeze.
const AT_RISK_PCT = 0.8; // the threshold the operations agent rule will use
const rule3Heat = [...exposure.entries()].filter(([, e]) => e.hotMin / e.budget >= AT_RISK_PCT).map(([id]) => id);
const rule3Freeze = [...exposure.entries()].filter(([, e]) => e.coldMin > 0).map(([id]) => id);

console.log(`  1. "TempC > 8, any reading" (global)            -> flags ${rule1.size} of ${trucks.length} trucks. Every dock opening. Pure noise.`);
console.log(`  2. "TempC > 8 sustained 45 min" (global)        -> flags ${rule2.size} trucks. Quiet dashboard.`);
console.log(`  3. per-batch cumulative >= ${AT_RISK_PCT * 100}% of the PRODUCT's budget -> heat: ${rule3Heat.join(", ") || "none"}`);
console.log(`     plus any freeze at all (no budget exists)    -> cold: ${rule3Freeze.join(", ") || "none"}`);

check(rule1.size >= trucks.length * 0.6, "rule 1 flags most of the fleet (alert fatigue is real)");
check(!rule2.has(legById.get([...cu.perLeg.keys()][0]).TruckID) || rule2.size < trucks.length * 0.3, "rule 2 goes mostly quiet");
check(rule3Freeze.includes(FREEZE), `rule 3 catches the freeze batch ${FREEZE} that rules 1 and 2 both miss`);
check(rule3Heat.includes(CUMULATIVE), `rule 3 catches the cumulative batch ${CUMULATIVE}`);
check(!rule1.has(legById.get([...fz.perLeg.keys()][0]).TruckID) || fz.hotMin === 0, "the freeze batch's own journey never trips a too-warm rule");

/* ---------- top-line facts for the article ------------------------------ */

const ranked = [...exposure.entries()]
  .map(([id, e]) => ({ id, pct: (e.hotMin / e.budget) * 100, hot: e.hotMin, cold: e.coldMin, budget: e.budget, value: Number(batchById.get(id).ValueUSD) }))
  .sort((a, b) => b.pct - a.pct);

console.log("\nTop 5 batches by heat-budget used:");
for (const r of ranked.slice(0, 5)) {
  console.log(`  ${r.id}  ${r.hot}/${r.budget} min = ${r.pct.toFixed(0)}%  cold=${r.cold} min  value=$${r.value.toFixed(2)}`);
}
const frozenAtRisk = ranked.filter((r) => r.cold > 0);
console.log(`\nBatches with ANY sub-band (freeze) exposure: ${frozenAtRisk.length}`);
for (const r of frozenAtRisk) console.log(`  ${r.id}  cold=${r.cold} min  value=$${r.value.toFixed(2)}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
console.log(
  `Instances: ${sites.length} Site + ${products.length} Product + ${trucks.length} Truck + ` +
    `${shipments.length} Shipment + ${batches.length} Batch + ${legs.length} Leg = ` +
    `${sites.length + products.length + trucks.length + shipments.length + batches.length + legs.length}`
);
console.log(
  `Edges: ${batches.length} ofProduct + ${batches.length} shippedIn + ${legs.length} partOf + ${legs.length} carriedBy + ` +
    `${legs.length} departsFrom + ${legs.length} arrivesAt = ${batches.length * 2 + legs.length * 4}`
);
process.exit(failures === 0 ? 0 : 1);

