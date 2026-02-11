import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPostcodeLocation,
  fetchPricePaidByPostcode,
  fetchPricePaidViewport,
  fetchCouncilTax,
  fetchAffordableHeatmap,
  fetchSectorRankings,
  PricePaidPoint,
  SectorStat,
  PropertyTypeRange,
  AffordableHeatmapPoint,
} from "./api/client";
import MapView from "./components/MapView";

function computeMaxAffordable({
  monthlyBudget,
  deposit,
  mortgageRate,
  termYears,
}: {
  monthlyBudget: number;
  deposit: number;
  mortgageRate: number;
  termYears: number;
}) {
  const monthlyRate = mortgageRate / 100 / 12;
  const n = termYears * 12;
  if (n <= 0) return deposit;
  const loan =
    monthlyRate === 0
      ? monthlyBudget * n
      : (monthlyBudget * (Math.pow(1 + monthlyRate, n) - 1)) /
        (monthlyRate * Math.pow(1 + monthlyRate, n));
  return Math.max(loan, 0) + deposit;
}

function computeMonthlyPaymentFromPrincipal({
  principal,
  mortgageRate,
  termYears,
}: {
  principal: number;
  mortgageRate: number;
  termYears: number;
}) {
  const monthlyRate = mortgageRate / 100 / 12;
  const n = termYears * 12;
  if (n <= 0) return 0;
  if (monthlyRate === 0) return principal / n;
  const pow = Math.pow(1 + monthlyRate, n);
  return principal * (monthlyRate * pow) / (pow - 1);
}

function computePrincipalFromMonthly({
  monthlyBudget,
  mortgageRate,
  termYears,
}: {
  monthlyBudget: number;
  mortgageRate: number;
  termYears: number;
}) {
  const monthlyRate = mortgageRate / 100 / 12;
  const n = termYears * 12;
  if (n <= 0) return 0;
  if (monthlyRate === 0) return monthlyBudget * n;
  return (monthlyBudget * (Math.pow(1 + monthlyRate, n) - 1)) /
    (monthlyRate * Math.pow(1 + monthlyRate, n));
}

function computeSdltStandard(price: number) {
  const bands = [
    { upTo: 125000, rate: 0 },
    { upTo: 250000, rate: 0.02 },
    { upTo: 925000, rate: 0.05 },
    { upTo: 1500000, rate: 0.1 },
    { upTo: Infinity, rate: 0.12 },
  ];
  let remaining = Math.max(price, 0);
  let prev = 0;
  let total = 0;
  for (const band of bands) {
    const taxable = Math.min(remaining, band.upTo - prev);
    if (taxable > 0) {
      total += taxable * band.rate;
      remaining -= taxable;
    }
    prev = band.upTo;
    if (remaining <= 0) break;
  }
  return Math.round(total);
}

function computeSdltFirstTimeBuyer(price: number) {
  if (price > 500000) {
    return computeSdltStandard(price);
  }
  const bands = [
    { upTo: 300000, rate: 0 },
    { upTo: 500000, rate: 0.05 },
  ];
  let remaining = Math.max(price, 0);
  let prev = 0;
  let total = 0;
  for (const band of bands) {
    const taxable = Math.min(remaining, band.upTo - prev);
    if (taxable > 0) {
      total += taxable * band.rate;
      remaining -= taxable;
    }
    prev = band.upTo;
    if (remaining <= 0) break;
  }
  return Math.round(total);
}

function bboxEquals(a: number[] | null, b: number[] | null) {
  if (!a || !b) return false;
  return a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
}

export default function App() {
  const [pricePaidPoints, setPricePaidPoints] = useState<PricePaidPoint[]>([]);
  const [sectors, setSectors] = useState<SectorStat[]>([]);
  const [rankMeta, setRankMeta] = useState<{
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
  } | null>(null);
  const [typeRanges, setTypeRanges] = useState<PropertyTypeRange[]>([]);
  const [affordableHeatmap, setAffordableHeatmap] = useState<AffordableHeatmapPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewportLoading, setViewportLoading] = useState(false);
  const [currentZoom, setCurrentZoom] = useState<number | null>(null);
  const [postcodeQuery, setPostcodeQuery] = useState("");
  const [postcodeError, setPostcodeError] = useState<string | null>(null);
  const [postcodeLocation, setPostcodeLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [postcodeResults, setPostcodeResults] = useState<PricePaidPoint[]>([]);
  const [priorityOrder, setPriorityOrder] = useState(["price", "commute", "schools", "crime"]);
  const [filters, setFilters] = useState({
    maxCommute: 60,
    minSchools: 60,
    maxCrime: 60,
  });
  const [propertyType, setPropertyType] = useState("ALL");
  const [affordability, setAffordability] = useState({
    incomeAnnual: 60000,
    monthlyBudget: 1200,
    deposit: 30000,
    mortgageRate: 4.5,
    termYears: 25,
  });
  const [monthlyBudgetTouched, setMonthlyBudgetTouched] = useState(false);
  const [councilTaxMonthly, setCouncilTaxMonthly] = useState(150);
  const [purchasePrice, setPurchasePrice] = useState(350000);
  const [purchasePriceTouched, setPurchasePriceTouched] = useState(false);
  const [fees, setFees] = useState({
    legal: 1500,
    survey: 600,
    mortgage: 1000,
    moving: 300,
    other: 0,
  });
  const [isFirstTimeBuyer, setIsFirstTimeBuyer] = useState(true);
  const [commute, setCommute] = useState({
    workplacePostcode: "",
    commuteMode: "PUBLIC",
    commuteDaysPerWeek: 5,
    commuteCostSensitivity: 0.6,
  });
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showCentroids, setShowCentroids] = useState(false);
  const [showBestFit, setShowBestFit] = useState(true);
  const [selectedSector, setSelectedSector] = useState<SectorStat | null>(null);
  const [bestFitSort, setBestFitSort] = useState("score");
  const zoomThreshold = Number(import.meta.env.VITE_ZOOM_THRESHOLD || 8);

  const viewportTimer = useRef<number | null>(null);
  const lastBboxRef = useRef<number[] | null>(null);
  const lastZoomRef = useRef<number | null>(null);
  const lastRequestKeyRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  const priorityOptions = [
    { value: "price", label: "Price Paid (higher better)" },
    { value: "commute", label: "Commute Time (lower better)" },
    { value: "schools", label: "Schools (higher better)" },
    { value: "crime", label: "Crime (lower better)" },
  ];

  const propertyTypeLabels: Record<string, string> = {
    D: "Detached",
    S: "Semi-detached",
    T: "Terraced",
    F: "Flat / Maisonette",
    O: "Other",
  };

  const maxAffordable = useMemo(
    () => computeMaxAffordable(affordability),
    [affordability]
  );

  const incomeMortgagePrincipal = useMemo(() => {
    const income = Number(affordability.incomeAnnual ?? 0);
    return income > 0 ? income * 4 : 0;
  }, [affordability.incomeAnnual]);

  const incomeMaxMonthly = useMemo(() => {
    if (!incomeMortgagePrincipal) return 0;
    return computeMonthlyPaymentFromPrincipal({
      principal: incomeMortgagePrincipal,
      mortgageRate: affordability.mortgageRate,
      termYears: affordability.termYears,
    });
  }, [incomeMortgagePrincipal, affordability.mortgageRate, affordability.termYears]);

  const incomeMaxMonthlyHard = useMemo(() => incomeMaxMonthly * 1.2, [incomeMaxMonthly]);
  const incomeDefaultMonthly = useMemo(() => incomeMaxMonthly * 0.8, [incomeMaxMonthly]);
  const bankCapPurchasePrice = useMemo(
    () => incomeMortgagePrincipal + Math.max(affordability.deposit || 0, 0),
    [incomeMortgagePrincipal, affordability.deposit]
  );
  const depositPctOfBankCap = useMemo(() => {
    if (!bankCapPurchasePrice) return 0;
    return (Math.max(affordability.deposit || 0, 0) / bankCapPurchasePrice) * 100;
  }, [bankCapPurchasePrice, affordability.deposit]);
  const bankCapMonthlyGap = useMemo(() => {
    if (!incomeMaxMonthly) return null;
    return affordability.monthlyBudget - incomeMaxMonthly;
  }, [affordability.monthlyBudget, incomeMaxMonthly]);

  useEffect(() => {
    if (!Number.isFinite(incomeMaxMonthly) || incomeMaxMonthly <= 0) return;
    setAffordability((prev) => {
      let nextBudget = prev.monthlyBudget;
      if (!monthlyBudgetTouched) {
        nextBudget = Math.round(incomeDefaultMonthly);
      }
      if (Number.isFinite(incomeMaxMonthlyHard) && nextBudget > incomeMaxMonthlyHard) {
        nextBudget = Math.round(incomeMaxMonthlyHard);
      }
      if (nextBudget === prev.monthlyBudget) return prev;
      return { ...prev, monthlyBudget: nextBudget };
    });
  }, [incomeDefaultMonthly, incomeMaxMonthly, incomeMaxMonthlyHard, monthlyBudgetTouched]);

  useEffect(() => {
    if (!purchasePriceTouched) {
      setPurchasePrice(Math.round(maxAffordable));
    }
  }, [maxAffordable, purchasePriceTouched]);

  const stampDuty = useMemo(() => {
    if (!Number.isFinite(purchasePrice)) return 0;
    return isFirstTimeBuyer
      ? computeSdltFirstTimeBuyer(purchasePrice)
      : computeSdltStandard(purchasePrice);
  }, [purchasePrice, isFirstTimeBuyer]);

  const totalFees = useMemo(
    () =>
      Math.round(
        (Number(fees.legal) || 0) +
          (Number(fees.survey) || 0) +
          (Number(fees.mortgage) || 0) +
          (Number(fees.moving) || 0) +
          (Number(fees.other) || 0)
      ),
    [fees]
  );

  const totalCashNeeded = useMemo(
    () => Math.max(0, Math.round(affordability.deposit + stampDuty + totalFees)),
    [affordability.deposit, stampDuty, totalFees]
  );

  const viewportNotice = viewportLoading
    ? "Loading price-paid points..."
    : "Heatmap updates as you move the map.";

  const fetchRankingsForBbox = (bbox: number[], zoom: number | null) => {
    const useViewport = zoom !== null && zoom >= zoomThreshold;
    const payload = {
      zoom,
      bbox,
      affordability: {
        ...affordability,
        workplacePostcode: commute.workplacePostcode || null,
        commuteMode: commute.commuteMode,
        commuteDaysPerWeek: commute.commuteDaysPerWeek,
        commuteCostSensitivity: commute.commuteCostSensitivity,
      },
      filters,
      priorities: priorityOrder,
      propertyType,
      limit: 50,
    };
    const requestKey = JSON.stringify(payload);
    if (lastRequestKeyRef.current === requestKey) return;
    lastRequestKeyRef.current = requestKey;

    requestIdRef.current += 1;
    const requestId = requestIdRef.current;

    setViewportLoading(true);
    setSectors([]);
    const pricePromise = useViewport ? fetchPricePaidViewport(bbox, 5000) : Promise.resolve({ rows: [] });
    const heatmapLimit = useViewport ? 2000 : 1200;
    const heatmapPromise = fetchAffordableHeatmap({ ...payload, limit: heatmapLimit }).catch(() => ({
      mode: "grid",
      rows: [],
    }));

    Promise.all([pricePromise, fetchSectorRankings(payload), heatmapPromise])
      .then(([priceData, rankedData, heatmapData]) => {
        if (requestId !== requestIdRef.current) return;
        setPricePaidPoints(priceData.rows);
        setSectors(rankedData.rows);
        setRankMeta(rankedData.meta ?? null);
        setTypeRanges(rankedData.meta?.type_ranges ?? []);
        let heatmapRows = heatmapData.rows ?? [];
        if (heatmapRows.length === 0 && rankedData.rows?.length) {
          heatmapRows = rankedData.rows
            .filter((sector) => Number.isFinite(sector.longitude) && Number.isFinite(sector.latitude))
            .map((sector) => {
              const ratio =
                typeof sector.affordability_ratio === "number"
                  ? Math.max(0, Math.min(1, sector.affordability_ratio))
                  : null;
              const weight = ratio !== null ? Math.max(0.2, 1 - ratio) : 0.6;
              return {
                longitude: sector.longitude,
                latitude: sector.latitude,
                weight,
                count: sector.transactions ?? 1,
              } as AffordableHeatmapPoint;
            });
        }
        setAffordableHeatmap(heatmapRows);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        lastRequestKeyRef.current = null;
        if (!useViewport) {
          setPricePaidPoints([]);
        }
        setSectors([]);
        setRankMeta(null);
        setTypeRanges([]);
        setAffordableHeatmap([]);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setViewportLoading(false);
        }
      });
  };

  const handleViewportChange = (bbox: number[], zoom: number) => {
    setCurrentZoom(zoom);
    if (bboxEquals(lastBboxRef.current, bbox) && lastZoomRef.current === zoom) return;

    lastBboxRef.current = bbox;
    lastZoomRef.current = zoom;

    if (viewportTimer.current) {
      window.clearTimeout(viewportTimer.current);
    }

    viewportTimer.current = window.setTimeout(() => {
      fetchRankingsForBbox(bbox, zoom);
    }, 600);
  };

  const forceRefresh = () => {
    if (!lastBboxRef.current) return;
    lastRequestKeyRef.current = null;
    fetchRankingsForBbox(lastBboxRef.current, lastZoomRef.current);
  };

  useEffect(() => {
    if (!lastBboxRef.current) return;
    if (viewportTimer.current) window.clearTimeout(viewportTimer.current);
    viewportTimer.current = window.setTimeout(() => {
      fetchRankingsForBbox(lastBboxRef.current as number[], lastZoomRef.current);
    }, 350);
  }, [affordability, commute, filters, priorityOrder, propertyType]);

  useEffect(() => {
    if (commute.workplacePostcode && bestFitSort === "score") {
      setBestFitSort("commute");
    }
  }, [commute.workplacePostcode, bestFitSort]);

  const scoredSectors = useMemo(() => {
    const rows = [...sectors];
    const compareNullable = (a: number | null | undefined, b: number | null | undefined) => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return a - b;
    };

    switch (bestFitSort) {
      case "commute":
        rows.sort((a, b) => compareNullable(a.commute_minutes, b.commute_minutes));
        break;
      case "cost":
        rows.sort((a, b) => compareNullable(a.commute_cost_monthly, b.commute_cost_monthly));
        break;
      case "affordability":
        rows.sort((a, b) => compareNullable(a.affordability_ratio, b.affordability_ratio));
        break;
      default:
        rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        break;
    }
    return rows;
  }, [sectors, bestFitSort]);

  const loadCouncilTax = (postcode: string) => {
    fetchCouncilTax(postcode)
      .then((councilTax) => {
        if (Number.isFinite(councilTax?.monthly_estimate ?? NaN)) {
          setCouncilTaxMonthly(councilTax.monthly_estimate ?? 0);
        }
      })
      .catch(() => {});
  };

  const handlePostcodeSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!postcodeQuery.trim()) return;
    setPostcodeError(null);
    fetchPostcodeLocation(postcodeQuery)
      .then((data) => {
        setPostcodeLocation({ latitude: data.location.latitude, longitude: data.location.longitude });
        loadCouncilTax(postcodeQuery);
        return fetchPricePaidByPostcode(postcodeQuery, 100);
      })
      .then((priceData) => setPostcodeResults(priceData.rows))
      .catch((err) => {
        setPostcodeError(err.message || "Postcode not found");
        setPostcodeLocation(null);
        setPostcodeResults([]);
      });
  };

  const updatePriority = (index: number, value: string) => {
    const next = [...priorityOrder];
    next[index] = value;
    const unique = Array.from(new Set(next));
    while (unique.length < priorityOrder.length) {
      const remaining = priorityOptions.map((opt) => opt.value).find((v) => !unique.includes(v));
      if (!remaining) break;
      unique.push(remaining);
    }
    setPriorityOrder(unique);
  };

  const movePriority = (from: number, to: number) => {
    if (to < 0 || to >= priorityOrder.length) return;
    const next = [...priorityOrder];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setPriorityOrder(next);
  };

  const lastPayloadPreview = useMemo(() => {
    if (!lastBboxRef.current) return "No viewport yet";
    return JSON.stringify(
      {
        zoom: lastZoomRef.current,
        bbox: lastBboxRef.current,
        affordability: {
          ...affordability,
          workplacePostcode: commute.workplacePostcode || null,
          commuteMode: commute.commuteMode,
          commuteDaysPerWeek: commute.commuteDaysPerWeek,
          commuteCostSensitivity: commute.commuteCostSensitivity,
        },
        filters,
        priorities: priorityOrder,
        propertyType,
      },
      null,
      2
    );
  }, [affordability, commute, filters, priorityOrder, propertyType, currentZoom]);

  return (
    <div className="min-h-screen text-slate-900">
      {viewportLoading && (
        <div className="pointer-events-none fixed left-0 top-0 z-50 h-1 w-full overflow-hidden bg-transparent">
          <div className="h-full w-1/3 animate-[loading_1.2s_ease_infinite] rounded-full bg-emerald-500/90" />
        </div>
      )}
      <style>{`
        @keyframes loading {
          0% { transform: translateX(-100%); width: 30%; }
          50% { transform: translateX(70%); width: 40%; }
          100% { transform: translateX(200%); width: 30%; }
        }
      `}</style>
      <div className="grid min-h-screen grid-cols-1 gap-0 lg:h-screen lg:grid-cols-[420px_1fr] lg:overflow-hidden">
        <aside className="border-b border-slate-200/60 bg-white/75 p-6 shadow-[0_10px_30px_-25px_rgba(15,23,42,0.5)] backdrop-blur lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="mb-8">
            <h1 className="font-display text-3xl font-semibold text-slate-900">myfirsthomie</h1>
            <p className="mt-2 text-sm text-slate-600">
              Discover affordable pockets with CPIH‑adjusted prices, then explore the latest sales on a live map.
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-[11px] text-slate-600">
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-700">Affordability‑first</span>
              <span className="rounded-full bg-slate-100 px-3 py-1">England & Wales</span>
              <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-800">CPIH‑adjusted</span>
            </div>
          </div>

          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Affordability</p>
              <div className="mt-4 space-y-4">
                <div>
                  <label className="text-xs text-slate-600">Annual Income (£)</label>
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    type="number"
                    min={0}
                    step={1000}
                    value={affordability.incomeAnnual}
                    onChange={(e) =>
                      setAffordability({ ...affordability, incomeAnnual: Number(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-600">Monthly Budget (£)</label>
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    type="number"
                    min={300}
                    step={50}
                    value={affordability.monthlyBudget}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      const capped =
                        Number.isFinite(incomeMaxMonthlyHard) && incomeMaxMonthlyHard > 0
                          ? Math.min(next, incomeMaxMonthlyHard)
                          : next;
                      setMonthlyBudgetTouched(true);
                      setAffordability({ ...affordability, monthlyBudget: capped });
                    }}
                  />
                  {incomeMaxMonthly > 0 && (
                    <div className="mt-2 space-y-1 text-[11px] text-slate-500">
                      <div>
                        Bank cap (4× income): £{Math.round(incomeMortgagePrincipal).toLocaleString()} loan ·
                        max £{Math.round(incomeMaxMonthly).toLocaleString()}/mo
                      </div>
                      <div>
                        Hard cap 120%: £{Math.round(incomeMaxMonthlyHard).toLocaleString()}/mo · default 80%
                      </div>
                    </div>
                  )}
                  {incomeMaxMonthly > 0 && affordability.monthlyBudget > incomeMaxMonthly && (
                    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Above pay grade (&gt;{Math.round((affordability.monthlyBudget / incomeMaxMonthly) * 100)}% of bank cap)
                    </div>
                  )}
                </div>
                <div>
                  <label className="text-xs text-slate-600">Deposit (£)</label>
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    type="number"
                    min={0}
                    step={1000}
                    value={affordability.deposit}
                    onChange={(e) => setAffordability({ ...affordability, deposit: Number(e.target.value) })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-600">Rate (%)</label>
                    <input
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                      type="number"
                      min={0}
                      step={0.1}
                      value={affordability.mortgageRate}
                      onChange={(e) =>
                        setAffordability({ ...affordability, mortgageRate: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-600">Term (Years)</label>
                    <input
                      className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                      type="number"
                      min={5}
                      max={40}
                      value={affordability.termYears}
                      onChange={(e) => setAffordability({ ...affordability, termYears: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  Budget-based max price: £{Math.round(maxAffordable).toLocaleString()}
                </div>
                {incomeMaxMonthly > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">
                        Bank-cap purchase: £{Math.round(bankCapPurchasePrice).toLocaleString()}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                        Deposit {depositPctOfBankCap.toFixed(1)}%
                      </span>
                    </div>
                    <div className="mt-2 text-[11px] text-slate-500">
                      Mortgage / mo at bank cap: £{Math.round(incomeMaxMonthly).toLocaleString()}
                      {bankCapMonthlyGap !== null && (
                        <span className="ml-2">
                          · Budget {bankCapMonthlyGap >= 0 ? "▲" : "▼"} £
                          {Math.abs(Math.round(bankCapMonthlyGap)).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Commute</p>
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="text-xs text-slate-600">Workplace postcode</label>
                      <input
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                        type="text"
                        placeholder="e.g., SE1 2AA"
                        value={commute.workplacePostcode}
                        onChange={(e) =>
                          setCommute({ ...commute, workplacePostcode: e.target.value.toUpperCase() })
                        }
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-slate-600">Mode</label>
                        <select
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                          value={commute.commuteMode}
                          onChange={(e) => setCommute({ ...commute, commuteMode: e.target.value })}
                        >
                          <option value="PUBLIC">Public transport</option>
                          <option value="DRIVING">Driving</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-slate-600">Days / week</label>
                        <input
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                          type="number"
                          min={1}
                          max={7}
                          value={commute.commuteDaysPerWeek}
                          onChange={(e) =>
                            setCommute({ ...commute, commuteDaysPerWeek: Number(e.target.value) })
                          }
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-slate-600">
                        Cost sensitivity: {(commute.commuteCostSensitivity * 100).toFixed(0)}%
                      </label>
                      <input
                        className="mt-2 w-full"
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={commute.commuteCostSensitivity * 100}
                        onChange={(e) =>
                          setCommute({
                            ...commute,
                            commuteCostSensitivity: Number(e.target.value) / 100,
                          })
                        }
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] text-slate-500">
                    Commute cost reduces affordability based on sensitivity. Public transport uses driving time in the MVP.
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Upfront costs</p>
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className="text-xs text-slate-600">Target purchase price</label>
                      <div className="mt-2 flex gap-2">
                        <input
                          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                          type="number"
                          min={0}
                          step={5000}
                          value={purchasePrice}
                          onChange={(e) => {
                            setPurchasePriceTouched(true);
                            setPurchasePrice(Number(e.target.value));
                          }}
                        />
                        <button
                          type="button"
                          className="rounded-xl border border-emerald-500 bg-emerald-500/20 px-3 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-500/30"
                          onClick={() => {
                            setPurchasePriceTouched(false);
                            setPurchasePrice(Math.round(maxAffordable));
                          }}
                        >
                          Use max
                        </button>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={isFirstTimeBuyer}
                        onChange={(e) => setIsFirstTimeBuyer(e.target.checked)}
                      />
                      First-time buyer relief
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs text-slate-600">Legal fees</label>
                        <input
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                          type="number"
                          min={0}
                          step={50}
                          value={fees.legal}
                          onChange={(e) => setFees({ ...fees, legal: Number(e.target.value) })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-600">Survey</label>
                        <input
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                          type="number"
                          min={0}
                          step={50}
                          value={fees.survey}
                          onChange={(e) => setFees({ ...fees, survey: Number(e.target.value) })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-600">Mortgage fees</label>
                        <input
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                          type="number"
                          min={0}
                          step={50}
                          value={fees.mortgage}
                          onChange={(e) => setFees({ ...fees, mortgage: Number(e.target.value) })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-slate-600">Moving</label>
                        <input
                          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                          type="number"
                          min={0}
                          step={50}
                          value={fees.moving}
                          onChange={(e) => setFees({ ...fees, moving: Number(e.target.value) })}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-slate-600">Other costs</label>
                      <input
                        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                        type="number"
                        min={0}
                        step={50}
                        value={fees.other}
                        onChange={(e) => setFees({ ...fees, other: Number(e.target.value) })}
                      />
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                      <div className="flex items-center justify-between">
                        <span>Stamp duty</span>
                        <span className="font-semibold">£{stampDuty.toLocaleString()}</span>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <span>Fees total</span>
                        <span className="font-semibold">£{totalFees.toLocaleString()}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-sm text-slate-900">
                        <span>Total cash needed</span>
                        <span className="font-semibold">£{totalCashNeeded.toLocaleString()}</span>
                      </div>
                    </div>
                    {isFirstTimeBuyer && purchasePrice > 500000 && (
                      <p className="text-[10px] text-rose-500">
                        First-time buyer relief applies only up to £500k; standard rates used above.
                      </p>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-slate-600">Property type</label>
                  <select
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                    value={propertyType}
                    onChange={(e) => setPropertyType(e.target.value)}
                  >
                    <option value="ALL">All property types</option>
                    <option value="D">Detached</option>
                    <option value="S">Semi-detached</option>
                    <option value="T">Terraced</option>
                    <option value="F">Flat / Maisonette</option>
                    <option value="O">Other</option>
                  </select>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <label className="text-xs text-slate-600">Postcode (optional)</label>
                  <form onSubmit={handlePostcodeSearch} className="mt-1 flex gap-2">
                    <input
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                      type="text"
                      placeholder="e.g., NW7 1SP"
                      value={postcodeQuery}
                      onChange={(e) => setPostcodeQuery(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="rounded-xl border border-emerald-500 bg-emerald-500/20 px-4 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-500/30"
                    >
                      Go
                    </button>
                  </form>
                  {postcodeError && <p className="mt-2 text-xs text-rose-600">{postcodeError}</p>}
                  {postcodeResults.length > 0 && (
                    <p className="mt-2 text-xs text-slate-600">
                      {postcodeResults.length} price paid records for {postcodeQuery.toUpperCase()}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Affordable Range (By Type)</p>
              <p className="mt-1 text-xs text-slate-500">
                Based on latest sales within your budget for the current zoom.
              </p>
              <div className="mt-4 space-y-2 text-xs text-slate-700">
                {typeRanges.length === 0 && (
                  <p className="text-xs text-slate-500">No affordable ranges yet for this view.</p>
                )}
                {typeRanges.map((range) => (
                  <div key={range.property_type} className="flex items-center justify-between rounded-xl bg-slate-50 px-2 py-2">
                    <span className="font-medium text-slate-700">
                      {propertyTypeLabels[range.property_type] ?? range.property_type}
                      <span className="ml-2 text-[10px] text-slate-500">({range.count})</span>
                    </span>
                    <span className="text-right text-xs text-slate-600">
                      £{range.min_price_adj.toLocaleString()}–£{range.max_price_adj.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Coverage Mode</p>
              <p className="mt-2 text-xs text-slate-500">
                {currentZoom !== null && currentZoom >= zoomThreshold
                  ? "Local view (zoomed): viewport sectors."
                  : "Nationwide view: precomputed sector stats."}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-4 shadow-sm">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Map Layers</p>
              <div className="mt-3 space-y-2 text-xs text-slate-700">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showBestFit}
                    onChange={(e) => setShowBestFit(e.target.checked)}
                  />
                  Show best-fit heatmap
                </label>
                <p className="text-[10px] text-slate-500">
                  Best-fit heatmap uses CPIH-adjusted affordability.
                </p>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showHeatmap}
                    onChange={(e) => setShowHeatmap(e.target.checked)}
                  />
                  Show transaction heatmap
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showCentroids}
                    onChange={(e) => setShowCentroids(e.target.checked)}
                  />
                  Show sector centroids
                </label>
                <div className="pt-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-emerald-300 hover:text-emerald-700"
                    onClick={forceRefresh}
                  >
                    Refresh results
                  </button>
                </div>
                <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Last Payload</div>
                  <pre className="mt-1 max-h-32 overflow-auto text-[10px] text-slate-600">
{lastPayloadPreview}
                  </pre>
                </div>
              </div>
            </div>
          </div>

          {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
          {postcodeResults.length > 0 && (
            <div className="mt-6 rounded-2xl border border-slate-200/70 bg-white/90 p-4 text-sm shadow-sm">
              <p className="font-semibold text-slate-900">Postcode Price Paid</p>
              <div className="mt-3 max-h-40 space-y-2 overflow-auto text-xs text-slate-700">
                {postcodeResults.slice(0, 10).map((row) => (
                  <div key={row.transaction_id} className="flex items-center justify-between">
                    <span>£{row.price.toLocaleString()}</span>
                    <span>{row.date_of_transfer}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-6 rounded-2xl border border-slate-200/70 bg-white/90 p-4 text-sm shadow-sm">
            <p className="font-semibold text-slate-900">Best Postcode Sectors</p>
            <p className="mt-1 text-xs text-slate-600">
              Ranked by latest affordable sale density (CPIH-adjusted) and commute impact when available.
            </p>
            {rankMeta?.commute?.destination?.postcode && (
              <p className="mt-2 text-[10px] text-slate-500">
                Commute target: {rankMeta.commute.destination.postcode}
                {rankMeta.commute.mode ? ` · ${rankMeta.commute.mode}` : ""}
              </p>
            )}
            {rankMeta?.commute?.error && (
              <p className="mt-2 text-[10px] text-rose-500">
                Commute lookup unavailable: {rankMeta.commute.error}
              </p>
            )}
            <div className="mt-3">
              <label className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Sort by</label>
              <select
                className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-inner shadow-slate-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                value={bestFitSort}
                onChange={(e) => setBestFitSort(e.target.value)}
              >
                <option value="score">Overall best fit</option>
                <option value="commute">Commute time (shortest)</option>
                <option value="cost">Commute cost (lowest)</option>
                <option value="affordability">Affordability ratio (lowest)</option>
              </select>
              <p className="mt-1 text-[10px] text-slate-500">
                Commute time is derived; cost sensitivity reduces affordability.
              </p>
            </div>
            {rankMeta?.price_year && rankMeta?.inflation_latest_year && (
              <p className="mt-2 text-[10px] text-slate-500">
                CPIH (2015=100): {rankMeta.price_year} {rankMeta.inflation_base_index ?? "—"} →{" "}
                {rankMeta.inflation_latest_year} {rankMeta.inflation_latest_index ?? "—"}
                {rankMeta.inflation_factor
                  ? ` (x${rankMeta.inflation_factor.toFixed(3)})`
                  : ""}
              </p>
            )}
            <div className="mt-4 max-h-56 space-y-2 overflow-auto text-xs text-slate-700">
              {scoredSectors.length === 0 && <p className="text-xs text-slate-500">No sectors loaded yet.</p>}
              {scoredSectors.map((sector) => (
                <button
                  key={sector.sector}
                  type="button"
                  onClick={() => setSelectedSector({ ...sector })}
                  className="flex w-full items-center justify-between rounded-xl border border-transparent px-3 py-2 text-left transition hover:border-emerald-200 hover:bg-emerald-50/60"
                >
                    <span>
                      <span className="font-medium">{sector.sector}</span>
                      <span className="block text-[10px] text-slate-500">
                        Affordable latest sales: {sector.transactions ?? 0}
                      </span>
                      {sector.commute_minutes != null && (
                        <span className="block text-[10px] text-slate-500">
                          Commute: {Math.round(sector.commute_minutes)} min
                          {sector.commute_cost_monthly != null
                            ? ` · £${Math.round(sector.commute_cost_monthly).toLocaleString()}/mo`
                            : ""}
                        </span>
                      )}
                      {sector.total_monthly_cost_adjusted != null && (
                        <span className="block text-[10px] text-slate-500">
                          Total monthly (adj): £{Math.round(sector.total_monthly_cost_adjusted).toLocaleString()}
                        </span>
                      )}
                      {sector.total_monthly_cost != null && councilTaxMonthly > 0 && (
                        <span className="block text-[10px] text-slate-500">
                          All-in monthly: £{Math.round(sector.total_monthly_cost + councilTaxMonthly).toLocaleString()}
                        </span>
                      )}
                      {sector.effective_monthly_budget != null && (
                        <span className="block text-[10px] text-slate-500">
                          Effective budget: £{Math.round(sector.effective_monthly_budget).toLocaleString()}
                        </span>
                      )}
                      {sector.affordability_cap_adjusted != null && (
                        <span className="block text-[10px] text-slate-500">
                          Adj. affordability: £{Math.round(sector.affordability_cap_adjusted).toLocaleString()}
                        </span>
                      )}
                    </span>
                  <span className="text-right">
                    £{Math.round(sector.median_price).toLocaleString()}
                    {sector.median_price_adj ?? sector.inflation_adjusted_price ? (
                      <span className="block text-[10px] text-slate-500">
                        £{Math.round(sector.median_price_adj ?? sector.inflation_adjusted_price ?? 0).toLocaleString()} (adj.)
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200/70 bg-white/90 p-4 text-sm shadow-sm">
            <p className="font-semibold text-slate-900">Price Paid Coverage</p>
            <p className="mt-1 text-xs text-slate-600">{viewportNotice}</p>
            <p className="mt-1 text-xs text-slate-500">
              Current zoom: {currentZoom ? currentZoom.toFixed(1) : "--"}
            </p>
            {pricePaidPoints.length > 0 && (
              <p className="mt-2 text-xs text-slate-600">{pricePaidPoints.length} records loaded.</p>
            )}
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200/70 bg-slate-50 p-4 opacity-70">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Ranking Preferences</p>
            <p className="mt-1 text-xs text-slate-500">Data not loaded yet.</p>
            <div className="mt-3 space-y-2">
              {priorityOrder.map((value, idx) => {
                const label = priorityOptions.find((opt) => opt.value === value)?.label ?? value;
                return (
                  <div
                    key={`priority-${value}`}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-400"
                  >
                    <span className="rounded border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] text-slate-400">
                      ⋮⋮
                    </span>
                    <span className="font-semibold">
                      #{idx + 1} · {label}
                    </span>
                    <span className="ml-auto text-[10px] text-slate-400">Weight {4 - idx}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200/70 bg-slate-50 p-4 opacity-70">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Filters</p>
            <p className="mt-1 text-xs text-slate-500">Data not loaded yet.</p>
            <div className="mt-3 space-y-3">
              <div>
                <label className="text-xs text-slate-600">
                  Min Schools Score: <span className="font-semibold">{filters.minSchools}</span>
                </label>
                <input
                  className="mt-2 w-full"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={filters.minSchools}
                  disabled
                  onChange={(e) => setFilters({ ...filters, minSchools: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-xs text-slate-600">
                  Max Crime Index: <span className="font-semibold">{filters.maxCrime}</span>
                </label>
                <input
                  className="mt-2 w-full"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={filters.maxCrime}
                  disabled
                  onChange={(e) => setFilters({ ...filters, maxCrime: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        </aside>

        <main className="relative p-4 lg:h-screen lg:p-6">
          <div className="relative h-[70vh] min-h-[520px] overflow-hidden rounded-3xl border border-slate-200/70 bg-white/70 shadow-[0_20px_50px_-40px_rgba(15,23,42,0.6)] lg:h-full">
            <MapView
              pricePaidPoints={pricePaidPoints}
              sectors={scoredSectors}
              affordableHeatmap={affordableHeatmap}
              showHeatmap={showHeatmap}
              showCentroids={showCentroids}
              showBestFit={showBestFit}
              affordability={{ ...affordability, ...commute }}
              maxAffordable={maxAffordable}
              propertyType={propertyType}
              selectedSector={selectedSector}
              councilTaxMonthly={councilTaxMonthly}
              onCouncilTaxUpdate={loadCouncilTax}
              onViewportChange={handleViewportChange}
              focusPoint={postcodeLocation}
            />
            <div className="pointer-events-none absolute bottom-4 left-4 right-4 rounded-xl border border-slate-200/70 bg-white/90 px-3 py-2 text-[10px] text-slate-500 shadow-sm">
              Contains HM Land Registry data © Crown copyright and database right 2021. This data is licensed
              under the Open Government Licence v3.0.
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
