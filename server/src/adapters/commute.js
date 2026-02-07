const ORS_BASE_URL = process.env.ORS_BASE_URL || "https://api.openrouteservice.org";
const ORS_API_KEY = process.env.ORS_API_KEY || process.env.COMMUTE_API_KEY;

export function normalizeCommuteMode(mode) {
  if (!mode) return "DRIVING";
  const normalized = String(mode).trim().toUpperCase();
  if (normalized.startsWith("PUB") || normalized.startsWith("TRANS")) return "PUBLIC";
  return "DRIVING";
}

function getProfileForMode(mode) {
  const normalized = normalizeCommuteMode(mode);
  if (normalized === "PUBLIC") {
    return "driving-car";
  }
  return "driving-car";
}

export async function fetchCommuteMatrix({ origins, destination, mode }) {
  if (!ORS_API_KEY) {
    throw new Error("ORS_API_KEY is not set");
  }
  if (!origins || origins.length === 0) return [];
  if (!destination || !Number.isFinite(destination.lng) || !Number.isFinite(destination.lat)) {
    throw new Error("Destination is required for commute matrix");
  }

  const profile = getProfileForMode(mode);
  const locations = [...origins, destination].map((point) => [point.lng, point.lat]);
  const sources = origins.map((_, idx) => idx);
  const destinations = [origins.length];

  const response = await fetch(`${ORS_BASE_URL}/v2/matrix/${profile}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: ORS_API_KEY,
    },
    body: JSON.stringify({
      locations,
      sources,
      destinations,
      metrics: ["duration", "distance"],
      units: "km",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Commute matrix failed (${response.status})`);
  }

  const data = await response.json();
  const durations = Array.isArray(data?.durations) ? data.durations : [];
  const distances = Array.isArray(data?.distances) ? data.distances : [];

  return origins.map((_, idx) => {
    const duration = Array.isArray(durations[idx]) ? durations[idx][0] : null;
    const distance = Array.isArray(distances[idx]) ? distances[idx][0] : null;
    return {
      duration_sec: Number.isFinite(duration) ? Math.round(Number(duration)) : null,
      distance_km: Number.isFinite(distance) ? Number(distance) : null,
    };
  });
}
