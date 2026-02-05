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
