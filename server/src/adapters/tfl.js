const TFL_BASE_URL = process.env.TFL_BASE_URL || "https://api.tfl.gov.uk";
const TFL_APP_KEY = process.env.TFL_APP_KEY;
const TFL_APP_ID = process.env.TFL_APP_ID;

const LONDON_BOUNDS = {
  minLat: 51.2868,
  maxLat: 51.6919,
  minLng: -0.5103,
  maxLng: 0.3340,
};

export function isWithinLondon(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return (
    lat >= LONDON_BOUNDS.minLat &&
    lat <= LONDON_BOUNDS.maxLat &&
    lng >= LONDON_BOUNDS.minLng &&
    lng <= LONDON_BOUNDS.maxLng
  );
}

// TfL PAYG fare estimates (2025) — used only when the Journey Planner API
// doesn't return an actual `fare` object for the chosen journey. The API
// omits fare data for many multi-modal journeys (e.g. Elizabeth Line + bus),
// so we approximate based on the mode mix to avoid falling back to the
// distance-based £/km estimate, which is dramatically wrong for tube/rail.
const FARE_ESTIMATE_GBP = {
  TUBE_OR_RAIL: 2.9,   // PAYG single, zone 1-2 typical
  CROSS_ZONE_RAIL: 4.0, // longer rail/Elizabeth Line trips
  BUS_ONLY: 1.75,      // bus single (Hopper free for 1 hour)
  WALKING_ONLY: 0,
};

function estimateFareFromLegs(journey) {
  const legs = Array.isArray(journey?.legs) ? journey.legs : [];
  if (!legs.length) return null;
  const modes = legs.map((l) => String(l?.mode?.name || "").toLowerCase());
  const hasRail = modes.some((m) =>
    ["tube", "dlr", "overground", "elizabeth-line", "national-rail", "tram"].includes(m)
  );
  const hasBus = modes.some((m) => m === "bus" || m === "coach");
  const allWalking = modes.every((m) => m === "walking");
  if (allWalking) return FARE_ESTIMATE_GBP.WALKING_ONLY;
  if (hasRail) {
    // Cross-zone heuristic: total journey duration > 35 min suggests longer trip
    const minutes = Number(journey?.duration) || 0;
    return minutes > 35 ? FARE_ESTIMATE_GBP.CROSS_ZONE_RAIL : FARE_ESTIMATE_GBP.TUBE_OR_RAIL;
  }
  if (hasBus) return FARE_ESTIMATE_GBP.BUS_ONLY;
  return FARE_ESTIMATE_GBP.TUBE_OR_RAIL;
}

function pickFareGbp(journey) {
  const fare = journey?.fare;

  if (fare && Number.isFinite(fare.totalCost)) {
    return Number(fare.totalCost) / 100;
  }

  if (fare && Array.isArray(fare.fares) && fare.fares.length) {
    const costs = [];
    fare.fares.forEach((item) => {
      if (Number.isFinite(item?.cost)) costs.push(Number(item.cost));
      if (Number.isFinite(item?.peak)) costs.push(Number(item.peak));
      if (Number.isFinite(item?.offPeak)) costs.push(Number(item.offPeak));
    });
    if (costs.length) {
      return Math.min(...costs) / 100;
    }
  }

  // No fare object in the response (common for multi-modal journeys involving
  // Elizabeth Line, bus interchanges, etc.) — estimate from the mode mix so
  // we don't silently fall through to the distance × £/km calc.
  return estimateFareFromLegs(journey);
}

function sumLegDistanceKm(journey) {
  const legs = Array.isArray(journey?.legs) ? journey.legs : [];
  const total = legs.reduce((acc, leg) => {
    const distance = Number(leg?.distance);
    if (!Number.isFinite(distance)) return acc;
    return acc + distance;
  }, 0);
  return total > 0 ? total / 1000 : null;
}

// Build the path segment for /Journey/JourneyResults. TfL accepts either a
// NaPTAN station ID (e.g. "940GZZLUOXC" for Oxford Circus) or a lat,lng pair.
// Stop IDs unlock the fare engine; lat/lng routes correctly but often misses
// the fare object. We prefer IDs whenever the caller has resolved one.
function endpointFor(point) {
  if (point?.naptan_id) return encodeURIComponent(point.naptan_id);
  return `${point.lat},${point.lng}`;
}

export async function fetchTflJourney({ origin, destination }) {
  if (!TFL_APP_KEY && !TFL_APP_ID) {
    throw new Error("TFL_APP_KEY is not set");
  }
  if (!origin || !destination) {
    throw new Error("Origin and destination required for TfL journey");
  }

  const from = endpointFor(origin);
  const to = endpointFor(destination);
  const url = new URL(`${TFL_BASE_URL}/Journey/JourneyResults/${from}/to/${to}`);
  url.searchParams.set("journeyPreference", "LeastTime");
  // Modes must match TfL's accepted set exactly. Common gotchas:
  //   - "train" is NOT valid; use "national-rail"
  //   - "river" is NOT valid; use "river-bus"
  // "elizabeth-line" was added in 2022 and is essential for east-west routing.
  url.searchParams.append(
    "mode",
    "bus,tube,dlr,overground,elizabeth-line,national-rail,tram,river-bus,walking,coach"
  );
  if (TFL_APP_ID) url.searchParams.set("app_id", TFL_APP_ID);
  if (TFL_APP_KEY) url.searchParams.set("app_key", TFL_APP_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `TfL Journey failed (${response.status})`);
  }
  const data = await response.json();
  const journeys = Array.isArray(data?.journeys) ? data.journeys : [];
  if (!journeys.length) {
    return { duration_sec: null, distance_km: null, fare_gbp: null };
  }
  const best = journeys.reduce((min, current) =>
    (current?.duration ?? Infinity) < (min?.duration ?? Infinity) ? current : min
  );
  const durationSec = Number.isFinite(best?.duration) ? Number(best.duration) * 60 : null;
  const distanceKm = sumLegDistanceKm(best);
  const fareGbp = pickFareGbp(best);

  return {
    duration_sec: Number.isFinite(durationSec) ? Math.round(durationSec) : null,
    distance_km: Number.isFinite(distanceKm) ? Number(distanceKm) : null,
    fare_gbp: Number.isFinite(fareGbp) ? Number(fareGbp) : null,
  };
}
