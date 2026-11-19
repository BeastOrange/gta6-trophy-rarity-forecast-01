import * as fs from 'node:fs';
import * as path from 'node:path';

type RecordValue = Record<string, unknown>;
type Snapshot = { time: number; x: number; players: number; rates: unknown[] };
type Observation = { x: number; y: number };
type Prior = { ceiling: number; pace: number; initial: number };

function object(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' ? value as RecordValue : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function timestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function bounded(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function logOdds(percent: number): number {
  const p = bounded(percent, 0.01, 99.99);
  return Math.log(p) - Math.log(100 - p);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}

function priorFor(trophy: RecordValue, current: number, reference: number): Prior {
  const description = typeof trophy.description === 'string' ? trophy.description.toLowerCase() : '';
  const chapter = /\bchapter\s+(\d{1,2})\b/.exec(description);
  const points = number(trophy.points) ? trophy.points : 15;
  const difficulty = bounded(Math.log2(Math.max(15, points) / 15), 0, 4);
  let prior = { ceiling: 22, pace: trophy.secret === true ? 0.68 : 0.8, initial: 0.8 };
  if (chapter) {
    const depth = Math.max(1, Number(chapter[1]));
    prior = { ceiling: 86 / depth ** 0.65, pace: 1.65 / depth ** 0.3, initial: 2 / depth };
  } else if (/final mission\.$/.test(description)) {
    prior = { ceiling: 28, pace: 0.85, initial: 0.4 };
  } else if (/100% completion|collectible|\ball\b|\bevery\b|\$[\d,]+|\b\d{2,}\b|mission strands/.test(description)) {
    prior = { ceiling: 8, pace: 0.55, initial: 0.25 };
  } else if (/stunt|\bwin\b|single use|escape|without being detected/.test(description)) {
    prior = { ceiling: 16, pace: 0.72, initial: 0.55 };
  }
  if (trophy.tier === 'platinum') return { ceiling: 3, pace: 0.42, initial: 0.12 };
  const tierScale = trophy.tier === 'gold' ? 0.8 : trophy.tier === 'silver' ? 0.86 : 1;
  const relative = bounded(logOdds(current) - logOdds(reference), -2, 3);
  return {
    ceiling: bounded(prior.ceiling * tierScale * Math.exp(0.23 * relative - 0.08 * difficulty), 1, 99.8),
    pace: prior.pace * tierScale * Math.exp(0.12 * relative - 0.04 * difficulty),
    initial: prior.initial * tierScale,
  };
}

function fit(reads: Observation[]) {
  const slopes: number[] = [];
  for (let i = 0; i < reads.length; i++) {
    for (let j = i + 1; j < reads.length; j++) {
      const distance = reads[j].x - reads[i].x;
      if (distance >= 0.18) slopes.push((reads[j].y - reads[i].y) / distance);
    }
  }
  const slope = bounded(median(slopes), -1.5, 4);
  const pivot = median(reads.map(read => read.y - slope * read.x));
  const noise = 1.48 * median(reads.map(read => Math.abs(read.y - slope * read.x - pivot)));
  const span = (reads.at(-1)?.x ?? 0) - (reads[0]?.x ?? 0);
  const confidence = slopes.length ? span / (span + 0.55) * reads.length / (reads.length + 3) / (1 + 2 * noise) : 0;
  return { slope, noise, confidence };
}

function forecast(input: RecordValue) {
  const hour = 3_600_000;
  const snapshotRows = list(input.history).map(object);
  const checkpoint = timestamp(input.at);
  const launchDate = timestamp(object(input.game).release_date);
  const launch = Number.isFinite(launchDate) ? launchDate : Date.UTC(2026, 10, 19);
  const xAt = (time: number) => Math.log1p(Math.max(0, (time - launch) / hour));
  const snapshots: Snapshot[] = snapshotRows.flatMap(row => {
    const time = timestamp(row.slot ?? row.at);
    if (!Number.isFinite(time) || time >= checkpoint) return [];
    return [{ time, x: xAt(time), players: number(row.players_tracked) ? row.players_tracked : 0, rates: list(row.rates) }];
  }).sort((a, b) => a.time - b.time);
  // Unchanged rates on a refreshed page are evidence of slow progression.
  // A repeated page should contribute no extra weight to the fit.
  const updates: Snapshot[] = [];
  const previousRates: unknown[] = [];
  for (const read of snapshots) {
    let changed = read.players !== updates.at(-1)?.players;
    read.rates.forEach((rate, index) => {
      if (number(rate) && rate >= 0 && rate <= 100) {
        if (rate !== previousRates[index]) changed = true;
        previousRates[index] = rate;
      }
    });
    if (changed) updates.push(read);
  }
  const latest = snapshots.at(-1);
  const at = Number.isFinite(checkpoint) ? checkpoint : latest?.time ?? launch;
  const targetTime = timestamp(input.target);
  const requestedHours = Number.isFinite(targetTime) ? (targetTime - at) / hour : input.horizon_minutes;
  const hours = number(requestedHours)
    ? bounded(Number.isFinite(targetTime) ? requestedHours : requestedHours / 60, 0, 24 * 30)
    : 24;
  const target = at + hours * hour;
  const days = hours / 24;
  const reference = median((latest?.rates ?? []).filter(number).filter(rate => rate > 0 && rate < 100)) || 1;
  const known = new Set<number>();
  const series = list(input.trophies).flatMap((value, index) => {
    const trophy = object(value);
    const id = trophy.id;
    if (!number(id) || known.has(id)) return [];
    known.add(id);
    const last = snapshots.findLast(read => {
      const rate = read.rates[index];
      return number(rate) && rate >= 0 && rate <= 100;
    });
    const observations: Observation[] = [];
    for (const read of updates) {
      const rate = read.rates[index];
      if (!number(rate) || rate < 0 || rate > 100) continue;
      observations.push({ x: read.x, y: logOdds(rate) });
    }
    const rate = last?.rates[index];
    const prior = priorFor(trophy, number(rate) ? rate : reference, reference);
    const recent = observations.filter(read => read.x >= xAt((latest?.time ?? at) - 28 * hour)).slice(-48);
    return [{ id, rate: number(rate) ? rate : prior.initial, last, prior, observations, fit: fit(recent) }];
  });
  const pooledSlopes = series.filter(row => row.fit.confidence > 0.2 && row.rate > 0 && row.rate < 100)
    .map(row => row.fit.slope / row.prior.pace);
  const commonPace = bounded(pooledSlopes.length ? median(pooledSlopes) : 1, 0.2, 2.6);
  return series.map(({ id, rate, last, prior, observations, fit: trend }) => {
    // A lone page state cannot distinguish stalled progression from a stale cache.
    const anchor = observations.length > 1 ? last?.time ?? at : at;
    const elapsed = Math.max(0, xAt(target) - xAt(anchor));
    const base = logOdds(rate);
    const ceiling = logOdds(Math.max(prior.ceiling, Math.min(99.99, rate * 1.3)));
    const priorWeight = observations.length === 1 ? days / (days + 0.5) : 1;
    const pace = prior.pace * commonPace * priorWeight * (1 - trend.confidence) + trend.slope * trend.confidence;
    const room = Math.max(0.04, ceiling - base);
    const growth = pace >= 0 ? room * -Math.expm1(-pace * elapsed / room) : pace * elapsed;
    const sparse = 1 / Math.sqrt(1 + 8 * trend.confidence);
    const boundary = rate <= 0.2 || rate >= 99.8 ? 0.2 : 0;
    const spread = Math.hypot(0.07, 0.26 * Math.sqrt(days), (0.16 + 0.36 * sparse) * elapsed,
      trend.noise * Math.sqrt(days), boundary * Math.sqrt(days));
    const center = rate === 100 ? Math.max(base, base + growth) : base + growth;
    const q = [-1.644854, -0.67449, 0, 0.67449, 1.644854].map(offset => {
      const percent = 100 / (1 + Math.exp(-(center + spread * offset)));
      return Number(percent.toFixed(5));
    });
    return { id, q };
  });
}

const source = process.env.MAKEFUN_INPUT_DIR || '/input';
const destination = process.env.MAKEFUN_OUTPUT_DIR || '/output';
fs.mkdirSync(destination, { recursive: true });
for (const name of fs.readdirSync(source).filter(name => name.endsWith('.in')).sort()) {
  let input: RecordValue = {};
  try {
    input = object(JSON.parse(fs.readFileSync(path.join(source, name), 'utf8')));
  } catch {
    // An unreadable case has no recoverable trophy IDs.
  }
  const id = typeof input.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(input.id) ? input.id : name.slice(0, -3);
  fs.writeFileSync(path.join(destination, id + '.out'), JSON.stringify({ trophies: forecast(input) }) + '\n');
}
