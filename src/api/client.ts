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

export type EpcInfo = {
  postcode_norm: string;
  floor_area_m2: number | null;
  floor_area_sqft: number | null;
  property_type?: string | null;
  tenure?: string | null;
  current_energy_rating?: string | null;
  lodgement_date?: string | null;
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
  commute_minutes?: number | null;
  commute_cost_monthly?: number | null;
  mortgage_monthly?: number | null;
  total_monthly_cost?: number | null;
  total_monthly_cost_adjusted?: number | null;
  budget_remaining?: number | null;
  effective_monthly_budget?: number | null;
  affordability_cap_adjusted?: number | null;
  affordability_ratio?: number | null;
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

export function fetchPricePaidViewportWithTenure(
  bbox: number[],
  limit: number,
  tenure?: string
) {
  const params = new URLSearchParams({
    bbox: bbox.join(","),
    limit: String(limit),
  });
  if (tenure && tenure !== "ALL") {
    params.set("tenure", tenure);
  }
  return json<{ rows: PricePaidPoint[] }>(`/api/price-paid/viewport?${params.toString()}`);
}

export function fetchPriceComps(params: {
  lat: number;
  lng: number;
  radiusKm?: number;
  years?: number;
  limit?: number;
  tenure?: string;
}) {
  const search = new URLSearchParams({
    lat: String(params.lat),
    lng: String(params.lng),
  });
  if (Number.isFinite(params.radiusKm ?? NaN)) {
    search.set("radiusKm", String(params.radiusKm ?? 1));
  }
  if (Number.isFinite(params.years ?? NaN)) {
    search.set("years", String(params.years ?? 2));
  }
  if (Number.isFinite(params.limit ?? NaN)) {
    search.set("limit", String(params.limit ?? 2000));
  }
  if (params.tenure && params.tenure !== "ALL") {
    search.set("tenure", params.tenure);
  }
  return json<{
    stats: {
      count: number;
      p25: number | null;
      median: number | null;
      p75: number | null;
      avg: number | null;
      min: number | null;
      max: number | null;
      latest_date?: string | null;
    } | null;
    meta: {
      radius_km: number;
      years: number;
      limit: number;
    };
  }>(`/api/price-paid/comps?${search.toString()}`);
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

export function fetchCouncilTax(postcode: string) {
  const params = new URLSearchParams({ postcode });
  return json<{
    row: {
      lad_code: string;
      lad_name?: string | null;
      year: number;
      band_d_annual: number;
    };
    monthly_estimate: number | null;
  }>(`/api/council-tax?${params.toString()}`);
}

export function fetchPostcodeLatest(postcode: string) {
  const params = new URLSearchParams({ postcode });
  return json<{
    row: PostcodeLatest;
    epc?: EpcInfo | null;
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
    epc?: EpcInfo | null;
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
  affordability: {
    incomeAnnual?: number;
    monthlyBudget: number;
    deposit: number;
    mortgageRate: number;
    termYears: number;
  },
  propertyType?: string,
  tenure?: string,
  commute?: {
    workplacePostcode?: string | null;
    commuteMode?: string | null;
    commuteDaysPerWeek?: number | null;
    commuteCostSensitivity?: number | null;
  }
) {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    monthlyBudget: String(affordability.monthlyBudget ?? 0),
    deposit: String(affordability.deposit ?? 0),
    mortgageRate: String(affordability.mortgageRate ?? 0),
    termYears: String(affordability.termYears ?? 0),
  });
  if (Number.isFinite(affordability.incomeAnnual ?? NaN)) {
    params.set("incomeAnnual", String(affordability.incomeAnnual ?? 0));
  }
  if (commute?.workplacePostcode) {
    params.set("workplacePostcode", commute.workplacePostcode);
  }
  if (commute?.commuteMode) {
    params.set("commuteMode", commute.commuteMode);
  }
  if (Number.isFinite(commute?.commuteDaysPerWeek ?? NaN)) {
    params.set("commuteDaysPerWeek", String(commute?.commuteDaysPerWeek ?? 0));
  }
  if (Number.isFinite(commute?.commuteCostSensitivity ?? NaN)) {
    params.set("commuteCostSensitivity", String(commute?.commuteCostSensitivity ?? 0));
  }
  if (propertyType && propertyType !== "ALL") {
    params.set("propertyType", propertyType);
  }
  if (tenure && tenure !== "ALL") {
    params.set("tenure", tenure);
  }
  return json<{
    row: PostcodeLatest & {
      latitude?: number;
      longitude?: number;
      postcode_norm?: string;
      price_adj?: number;
    };
    epc?: EpcInfo | null;
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
      commute?: {
        mode?: string | null;
        duration_sec?: number | null;
        distance_km?: number | null;
        cost_monthly?: number | null;
        days_per_week?: number | null;
        cost_per_km?: number | null;
        effective_monthly_budget?: number | null;
        affordability_cap_adjusted?: number | null;
      } | null;
      mortgage_monthly?: number | null;
      total_monthly_cost?: number | null;
      budget_remaining?: number | null;
      price_for_mortgage?: number | null;
    } | null;
  }>(`/api/postcode/nearest-affordable?${params.toString()}`);
}

export function fetchSectorRankings(payload: {
  zoom?: number;
  bbox?: number[];
  tenure?: string;
  affordability: {
    incomeAnnual?: number;
    monthlyBudget: number;
    deposit: number;
    mortgageRate: number;
    termYears: number;
    workplacePostcode?: string | null;
    commuteMode?: string | null;
    commuteDaysPerWeek?: number | null;
    commuteCostSensitivity?: number | null;
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
      commute?: {
        mode?: string | null;
        days_per_week?: number | null;
        cost_per_km?: number | null;
        destination?: {
          postcode?: string;
          latitude?: number;
          longitude?: number;
        } | null;
        error?: string | null;
      } | null;
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
  tenure?: string;
  affordability: {
    incomeAnnual?: number;
    monthlyBudget: number;
    deposit: number;
    mortgageRate: number;
    termYears: number;
    workplacePostcode?: string | null;
    commuteMode?: string | null;
    commuteDaysPerWeek?: number | null;
    commuteCostSensitivity?: number | null;
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
