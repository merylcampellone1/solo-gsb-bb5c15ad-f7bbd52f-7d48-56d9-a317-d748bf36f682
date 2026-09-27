// Cache retention planner.
//
// Given a resource size, the byte intervals already held in cache (closed
// intervals, possibly unordered, overlapping or adjacent), the predicted
// access intervals carrying a positive integer weight each, and a byte
// budget, decide which cached bytes to keep. Overlapping cache is counted
// once, overlapping accesses accumulate weight per byte, and only cached
// bytes with positive value are eligible. Bytes are selected by descending
// cumulative weight per byte (ties broken by ascending offset) until the
// budget is filled — a selection may end inside an interval — and the
// selected bytes are then merged into a minimal list of closed intervals.

export const MAX_CACHED_INTERVALS = 1000;
export const MAX_ACCESS_INTERVALS = 1000;
export const MAX_ACCESS_WEIGHT = 1_000_000;

/**
 * Plan which cached bytes to retain under a byte budget.
 *
 * @returns a result object with `statusCode` 200 carrying the retained
 *          closed intervals plus the byte accounting, or a 400 result
 *          describing the first validation failure.
 */
export function planCacheRetention(options) {
  const { size, cached, accesses, budgetBytes } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
    return fail('INVALID_BUDGET_BYTES', 'budgetBytes must be a non-negative safe integer');
  }
  if (!Array.isArray(cached)) {
    return fail('INVALID_CACHED', 'cached must be an array of {start, end} intervals');
  }
  if (cached.length > MAX_CACHED_INTERVALS) {
    return fail(
      'TOO_MANY_INTERVALS',
      `cached carries ${cached.length} intervals; at most ${MAX_CACHED_INTERVALS} are allowed`,
    );
  }
  for (let i = 0; i < cached.length; i += 1) {
    const interval = cached[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] must be an object with start and end`);
    }
    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(end) || end < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].end must be a non-negative safe integer`);
    }
    if (start > end) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] has start ${start} after end ${end}`);
    }
    if (end >= size) {
      return fail(
        'CACHED_RANGE_OUT_OF_BOUNDS',
        `cached[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
  }
  if (!Array.isArray(accesses)) {
    return fail('INVALID_ACCESSES', 'accesses must be an array of {start, end, weight} intervals');
  }
  if (accesses.length > MAX_ACCESS_INTERVALS) {
    return fail(
      'TOO_MANY_INTERVALS',
      `accesses carries ${accesses.length} intervals; at most ${MAX_ACCESS_INTERVALS} are allowed`,
    );
  }
  for (let i = 0; i < accesses.length; i += 1) {
    const interval = accesses[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail(
        'INVALID_ACCESS_RANGE',
        `accesses[${i}] must be an object with start, end and weight`,
      );
    }
    const { start, end, weight } = interval;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_ACCESS_RANGE', `accesses[${i}].start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(end) || end < 0) {
      return fail('INVALID_ACCESS_RANGE', `accesses[${i}].end must be a non-negative safe integer`);
    }
    if (start > end) {
      return fail('INVALID_ACCESS_RANGE', `accesses[${i}] has start ${start} after end ${end}`);
    }
    if (end >= size) {
      return fail(
        'ACCESS_RANGE_OUT_OF_BOUNDS',
        `accesses[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
    if (!Number.isSafeInteger(weight) || weight < 1) {
      return fail('INVALID_ACCESS_WEIGHT', `accesses[${i}].weight must be a positive safe integer`);
    }
    if (weight > MAX_ACCESS_WEIGHT) {
      return fail(
        'INVALID_ACCESS_WEIGHT',
        `accesses[${i}].weight is ${weight}; at most ${MAX_ACCESS_WEIGHT} is allowed`,
      );
    }
  }

  const cachedMerged = mergeIntervals(cached);
  const candidates = intersectCached(weightSegments(accesses), cachedMerged);

  // Highest cumulative weight per byte first; ties keep the lowest offsets.
  candidates.sort((a, b) => b.weight - a.weight || a.start - b.start);

  const selected = [];
  let remaining = budgetBytes;
  for (const segment of candidates) {
    if (remaining === 0) break;
    const length = segment.end - segment.start + 1;
    if (length <= remaining) {
      selected.push({ start: segment.start, end: segment.end });
      remaining -= length;
    } else {
      // The budget runs out inside this segment: every byte in it carries
      // the same weight, so the lowest offsets win.
      selected.push({ start: segment.start, end: segment.start + remaining - 1 });
      remaining = 0;
    }
  }

  const retained = mergeIntervals(selected);
  const retainedBytes = retained.reduce((sum, interval) => sum + (interval.end - interval.start + 1), 0);

  return {
    statusCode: 200,
    retained,
    retainedBytes,
    unusedBytes: budgetBytes - retainedBytes,
  };
}

/**
 * Sweep the access intervals into maximal constant-weight segments: the
 * cumulative weight of every byte covered by at least one access. Segments
 * come out ascending and disjoint; uncovered gaps carry zero value and are
 * omitted. `end + 1` never overflows because every end is below `size`,
 * which is itself at most Number.MAX_SAFE_INTEGER.
 */
function weightSegments(accesses) {
  const deltas = new Map();
  for (const { start, end, weight } of accesses) {
    deltas.set(start, (deltas.get(start) ?? 0) + weight);
    deltas.set(end + 1, (deltas.get(end + 1) ?? 0) - weight);
  }
  const boundaries = [...deltas.keys()].sort((a, b) => a - b);

  const segments = [];
  let cumulative = 0;
  let segmentStart = 0;
  for (const offset of boundaries) {
    if (cumulative > 0 && offset > segmentStart) {
      segments.push({ start: segmentStart, end: offset - 1, weight: cumulative });
    }
    cumulative += deltas.get(offset);
    segmentStart = offset;
  }
  return segments;
}

/**
 * Intersect the weighted segments with the merged cache intervals. Both
 * lists are ascending and disjoint, so the result — only cached bytes with
 * positive value — is too.
 */
function intersectCached(segments, cachedMerged) {
  const candidates = [];
  let c = 0;
  for (const segment of segments) {
    while (c < cachedMerged.length && cachedMerged[c].end < segment.start) c += 1;
    for (let k = c; k < cachedMerged.length && cachedMerged[k].start <= segment.end; k += 1) {
      candidates.push({
        start: Math.max(segment.start, cachedMerged[k].start),
        end: Math.min(segment.end, cachedMerged[k].end),
        weight: segment.weight,
      });
    }
  }
  return candidates;
}

/**
 * Sort closed intervals by start offset and merge overlapping or adjacent
 * ones ([0-9] and [10-19] merge into [0-19]).
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
