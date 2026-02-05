export type Region = {
  id: string;
  name: string;
  center: [number, number];
  polygon: [number, number][];
  avgPrice: number;
  commuteMins: number;
  crimeIndex: number;
  schoolsScore: number;
  employmentScore: number;
};

export type Inputs = {
  maxMonthlyBudget: number;
  deposit: number;
  mortgageRate: number;
  termYears: number;
  maxCommuteMins: number;
  maxCrimeIndex: number;
};

export type ScoredRegion = {
  region: Region;
  feasible: boolean;
  payment: number;
};

export type PricePaidPoint = {
  transaction_id: string;
  price: number;
  date_of_transfer: string;
  latitude: number;
  longitude: number;
  postcode: string;
};

export type SectorStat = {
  sector: string;
  median_price: number;
  avg_price: number;
  transactions: number;
  latitude: number;
  longitude: number;
  score?: number;
};

async function json<T>(input: RequestInfo, init?: RequestInit) {
  const res = await fetch(input, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function fetchFeasible(inputs: Inputs) {
  return json<{ scored: ScoredRegion[] }>("/api/feasible", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(inputs),
  });
}

export function searchRegions(query: string) {
  const params = new URLSearchParams({ q: query });
  return json<{ results: Region[] }>(`/api/search?${params.toString()}`);
}

export function fetchRegion(id: string) {
  return json<Region>(`/api/region/${encodeURIComponent(id)}`);
}

export function fetchPricePaidViewport(bbox: number[], limit = 2000) {
  const params = new URLSearchParams({
    bbox: bbox.join(","),
    limit: String(limit),
  });
  return json<{ rows: PricePaidPoint[] }>(`/api/price-paid/viewport?${params.toString()}`);
}

export function fetchSectorsViewport(bbox: number[], limit = 500) {
  const params = new URLSearchParams({
    bbox: bbox.join(","),
    limit: String(limit),
  });
  return json<{ rows: SectorStat[] }>(`/api/sectors/viewport?${params.toString()}`);
}

export function fetchSectors(limit = 2000) {
  const params = new URLSearchParams({ limit: String(limit) });
  return json<{ rows: SectorStat[] }>(`/api/sectors?${params.toString()}`);
}

export function fetchSectorRankings(payload: {
  scope: "viewport" | "nationwide";
  bbox?: number[];
  affordability: {
    monthlyBudget: number;
    deposit: number;
    mortgageRate: number;
    termYears: number;
  };
  filters: {
    maxPrice: number;
    maxCommute: number;
    minSchools: number;
    maxCrime: number;
  };
  priorities: string[];
  limit?: number;
}) {
  return json<{ rows: SectorStat[] }>(`/api/sector-rankings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchPostcodeLocation(postcode: string) {
  const params = new URLSearchParams({ postcode });
  return json<{ location: { postcode: string; latitude: number; longitude: number } }>(
    `/api/postcode?${params.toString()}`
  );
}

export function fetchPricePaidByPostcode(postcode: string, limit = 50) {
  const params = new URLSearchParams({ postcode, limit: String(limit) });
  return json<{ rows: PricePaidPoint[] }>(`/api/price-paid?${params.toString()}`);
}
