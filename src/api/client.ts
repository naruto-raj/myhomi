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

export function fetchPricePaidViewport(bbox: number[], limit = 2000) {
  const params = new URLSearchParams({
    bbox: bbox.join(","),
    limit: String(limit),
  });
  return json<{ rows: PricePaidPoint[] }>(`/api/price-paid/viewport?${params.toString()}`);
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
