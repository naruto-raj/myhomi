export type PricePaidPoint = {
  transaction_id: string;
  price: number;
  date_of_transfer: string;
  latitude: number;
  longitude: number;
  postcode: string;
};

export type PostcodeLatest = {
  transaction_id: string;
  price: number;
  date_of_transfer: string;
  postcode: string;
  postcode_norm?: string;
  property_type?: string;
  old_new?: string;
  duration?: string;
  paon?: string;
  saon?: string;
  street?: string;
  locality?: string;
  town_city?: string;
  district?: string;
  county?: string;
  ppd_category_type?: string;
  record_status?: string;
};

export type SectorStat = {
  sector: string;
  median_price: number;
  avg_price: number;
  median_price_adj?: number | null;
  avg_price_adj?: number | null;
  transactions: number;
  latitude: number;
  longitude: number;
  score?: number;
  inflation_adjusted_price?: number | null;
};

export type PropertyTypeRange = {
  property_type: string;
  min_price_adj: number;
  max_price_adj: number;
  count: number;
};

export type AffordableHeatmapPoint = {
  latitude: number;
  longitude: number;
  weight?: number;
  count?: number;
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

export function fetchPostcodeLatest(postcode: string) {
  const params = new URLSearchParams({ postcode });
  return json<{
    row: PostcodeLatest;
    meta?: {
      price_year?: number | null;
      inflation_base_year?: number | null;
      inflation_latest_year?: number | null;
      inflation_base_index?: number | null;
      inflation_latest_index?: number | null;
      inflation_factor?: number | null;
      inflation_adjusted_price?: number | null;
    } | null;
  }>(`/api/postcode/latest?${params.toString()}`);
}

export function fetchNearestPostcode(lat: number, lng: number) {
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  return json<{
    row: PostcodeLatest & {
      latitude?: number;
      longitude?: number;
      postcode_norm?: string;
    };
    meta?: {
      price_year?: number | null;
      inflation_base_year?: number | null;
      inflation_latest_year?: number | null;
      inflation_base_index?: number | null;
      inflation_latest_index?: number | null;
      inflation_factor?: number | null;
      inflation_adjusted_price?: number | null;
      inflation_percent_change?: number | null;
    } | null;
  }>(`/api/postcode/nearest?${params.toString()}`);
}

export function fetchNearestAffordablePostcode(
  lat: number,
  lng: number,
  affordability: { monthlyBudget: number; deposit: number; mortgageRate: number; termYears: number },
  propertyType?: string
) {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    monthlyBudget: String(affordability.monthlyBudget ?? 0),
    deposit: String(affordability.deposit ?? 0),
    mortgageRate: String(affordability.mortgageRate ?? 0),
    termYears: String(affordability.termYears ?? 0),
  });
  if (propertyType && propertyType !== "ALL") {
    params.set("propertyType", propertyType);
  }
  return json<{
    row: PostcodeLatest & {
      latitude?: number;
      longitude?: number;
      postcode_norm?: string;
      price_adj?: number;
    };
    meta?: {
      price_year?: number | null;
      inflation_base_year?: number | null;
      inflation_latest_year?: number | null;
      inflation_base_index?: number | null;
      inflation_latest_index?: number | null;
      inflation_factor?: number | null;
      inflation_adjusted_price?: number | null;
      inflation_percent_change?: number | null;
      affordability_cap?: number | null;
    } | null;
  }>(`/api/postcode/nearest-affordable?${params.toString()}`);
}

export function fetchSectorRankings(payload: {
  zoom?: number;
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
  propertyType?: string;
  limit?: number;
}) {
  return json<{
    rows: SectorStat[];
    meta?: {
      price_year?: number | null;
      inflation_latest_year?: number | null;
      inflation_base_index?: number | null;
      inflation_latest_index?: number | null;
      inflation_factor?: number | null;
      type_ranges?: PropertyTypeRange[];
    } | null;
  }>(`/api/sector-rankings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchAffordableHeatmap(payload: {
  zoom?: number;
  bbox: number[];
  affordability: {
    monthlyBudget: number;
    deposit: number;
    mortgageRate: number;
    termYears: number;
  };
  propertyType?: string;
  limit?: number;
}) {
  return json<{
    mode: "points" | "grid";
    rows: AffordableHeatmapPoint[];
    gridSize?: number;
  }>(`/api/affordable-heatmap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
