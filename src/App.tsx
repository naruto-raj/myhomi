import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchPostcodeLocation,
  fetchPricePaidByPostcode,
  fetchPricePaidViewport,
  fetchSectorRankings,
  PricePaidPoint,
  SectorStat,
} from "./api/client";
import MapView from "./components/MapView";

export default function App() {
  const [pricePaidPoints, setPricePaidPoints] = useState<PricePaidPoint[]>([]);
  const [sectors, setSectors] = useState<SectorStat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewportLoading, setViewportLoading] = useState(false);
  const [currentZoom, setCurrentZoom] = useState<number | null>(null);
  const [postcodeQuery, setPostcodeQuery] = useState("");
  const [postcodeError, setPostcodeError] = useState<string | null>(null);
  const [postcodeLocation, setPostcodeLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [postcodeResults, setPostcodeResults] = useState<PricePaidPoint[]>([]);
  const [priorityOrder, setPriorityOrder] = useState(["price", "commute", "schools", "crime"]);
  const [filters, setFilters] = useState({
    maxPrice: 5_000_000,
    maxCommute: 60,
    minSchools: 60,
    maxCrime: 60,
  });
  const [affordability, setAffordability] = useState({
    monthlyBudget: 2200,
    deposit: 60000,
    mortgageRate: 4.5,
    termYears: 30,
  });
  const viewportTimer = useRef<number | null>(null);
  const lastBboxRef = useRef<number[] | null>(null);
  const [scope, setScope] = useState<"viewport" | "nationwide">("viewport");
  const priorityOptions = [
    { value: "price", label: "Price Paid (higher better)" },
    { value: "commute", label: "Commute Time (lower better)" },
    { value: "schools", label: "Schools (higher better)" },
    { value: "crime", label: "Crime (lower better)" },
  ];
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const viewportNotice = viewportLoading
    ? "Loading price-paid points..."
    : "Heatmap updates as you move the map.";

  const handleViewportChange = (bbox: number[], zoom: number) => {
    setCurrentZoom(zoom);
    lastBboxRef.current = bbox;
    if (viewportTimer.current) {
      window.clearTimeout(viewportTimer.current);
    }
    viewportTimer.current = window.setTimeout(() => {
      setViewportLoading(true);
      const rankingsPayload = {
        scope,
        bbox,
        affordability,
        filters,
        priorities: priorityOrder,
        limit: 50,
      };
      Promise.all([fetchPricePaidViewport(bbox, 2000), fetchSectorRankings(rankingsPayload)])
        .then(([priceData, rankedData]) => {
          setPricePaidPoints(priceData.rows);
          setSectors(rankedData.rows);
        })
        .catch(() => {
          setPricePaidPoints([]);
          setSectors([]);
        })
        .finally(() => setViewportLoading(false));
    }, 350);
  };

  useEffect(() => {
    if (!lastBboxRef.current) return;
    if (viewportTimer.current) window.clearTimeout(viewportTimer.current);
    viewportTimer.current = window.setTimeout(() => {
      setViewportLoading(true);
      const rankingsPayload = {
        scope,
        bbox: lastBboxRef.current,
        affordability,
        filters,
        priorities: priorityOrder,
        limit: 50,
      };
      Promise.all([
        fetchPricePaidViewport(lastBboxRef.current, 2000),
        fetchSectorRankings(rankingsPayload),
      ])
        .then(([priceData, rankedData]) => {
          setPricePaidPoints(priceData.rows);
          setSectors(rankedData.rows);
        })
        .catch(() => {
          setPricePaidPoints([]);
          setSectors([]);
        })
        .finally(() => setViewportLoading(false));
    }, 350);
  }, [scope, affordability, filters, priorityOrder]);

  const scoredSectors = useMemo(() => sectors, [sectors]);

  const handlePostcodeSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!postcodeQuery.trim()) return;
    setPostcodeError(null);
    fetchPostcodeLocation(postcodeQuery)
      .then((data) => {
        setPostcodeLocation({ latitude: data.location.latitude, longitude: data.location.longitude });
        return fetchPricePaidByPostcode(postcodeQuery, 100);
      })
      .then((data) => setPostcodeResults(data.rows))
      .catch((err) => {
        setPostcodeError(err.message || "Postcode not found");
        setPostcodeLocation(null);
        setPostcodeResults([]);
      });
  };

  const updatePriority = (index: number, value: string) => {
    const next = [...priorityOrder];
    next[index] = value;
    // ensure uniqueness by de-duplicating in order
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

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900">
      <div className="grid min-h-screen grid-cols-1 gap-0 lg:grid-cols-[380px_1fr]">
        <aside className="border-b border-stone-200 bg-white p-6 lg:border-b-0 lg:border-r">
          <div className="mb-6">
            <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Phase 3</p>
            <h1 className="text-2xl font-semibold text-stone-900">Price Paid Explorer</h1>
            <p className="mt-2 text-sm text-stone-600">
              Search by postcode and explore price paid density with a live heatmap.
            </p>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-stone-600">Affordability</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-xs text-stone-600">Monthly Budget (£)</label>
                  <input
                    className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-xs text-stone-900"
                    type="number"
                    min={300}
                    step={50}
                    value={affordability.monthlyBudget}
                    onChange={(e) =>
                      setAffordability({ ...affordability, monthlyBudget: Number(e.target.value) })
                    }
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-600">Deposit (£)</label>
                  <input
                    className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-xs text-stone-900"
                    type="number"
                    min={0}
                    step={1000}
                    value={affordability.deposit}
                    onChange={(e) => setAffordability({ ...affordability, deposit: Number(e.target.value) })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-stone-600">Rate (%)</label>
                    <input
                      className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-xs text-stone-900"
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
                    <label className="text-xs text-stone-600">Term (Years)</label>
                    <input
                      className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-xs text-stone-900"
                      type="number"
                      min={5}
                      max={40}
                      value={affordability.termYears}
                      onChange={(e) => setAffordability({ ...affordability, termYears: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="rounded-md border border-stone-200 bg-white p-2">
                  <label className="text-xs text-stone-600">Postcode (optional)</label>
                  <form onSubmit={handlePostcodeSearch} className="mt-1 flex gap-2">
                    <input
                      className="w-full rounded-md border border-stone-300 bg-white px-2 py-2 text-xs text-stone-900"
                      type="text"
                      placeholder="e.g., NW7 1SP"
                      value={postcodeQuery}
                      onChange={(e) => setPostcodeQuery(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="rounded-md border border-emerald-500 bg-emerald-500/20 px-3 py-2 text-xs text-emerald-700"
                    >
                      Go
                    </button>
                  </form>
                  {postcodeError && <p className="mt-1 text-xs text-rose-600">{postcodeError}</p>}
                  {postcodeResults.length > 0 && (
                    <p className="mt-1 text-xs text-stone-600">
                      {postcodeResults.length} price paid records for {postcodeQuery.toUpperCase()}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-stone-600">Priority Order</p>
              <p className="mt-1 text-xs text-stone-500">Drag to reorder. Top item matters most.</p>
              <div className="mt-3 space-y-2">
                {priorityOrder.map((value, idx) => {
                  const label = priorityOptions.find((opt) => opt.value === value)?.label ?? value;
                  const isDragging = dragIndex === idx;
                  return (
                    <div
                      key={`priority-${value}`}
                      className={`flex items-center gap-2 rounded-md border px-2 py-2 text-xs ${
                        isDragging
                          ? "border-amber-400 bg-amber-200/60"
                          : "border-stone-200 bg-white"
                      }`}
                      draggable
                      onDragStart={() => setDragIndex(idx)}
                      onDragEnd={() => setDragIndex(null)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex === null) return;
                        movePriority(dragIndex, idx);
                        setDragIndex(null);
                      }}
                    >
                      <span className="rounded border border-stone-300 bg-stone-100 px-2 py-1 text-[10px] text-stone-600">
                        ⋮⋮
                      </span>
                      <span className="font-semibold text-stone-900">
                        #{idx + 1} · {label}
                      </span>
                      <span className="ml-auto text-[10px] text-stone-500">Weight {4 - idx}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-stone-600">Best Spots Scope</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className={`rounded-md border px-3 py-2 text-xs ${
                    scope === "viewport"
                      ? "border-emerald-500 bg-emerald-100 text-emerald-800"
                      : "border-stone-300 bg-white hover:border-emerald-400/60"
                  }`}
                  onClick={() => setScope("viewport")}
                >
                  Viewport
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-3 py-2 text-xs ${
                    scope === "nationwide"
                      ? "border-emerald-500 bg-emerald-100 text-emerald-800"
                      : "border-stone-300 bg-white hover:border-emerald-400/60"
                  }`}
                  onClick={() => setScope("nationwide")}
                >
                  Nationwide
                </button>
              </div>
              <p className="mt-2 text-xs text-stone-500">
                Viewport uses nearby sectors. Nationwide uses precomputed sector stats.
              </p>
            </div>
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-stone-600">Filters</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="text-xs text-stone-600">
                    Max Commute (mins): <span className="font-semibold">{filters.maxCommute}</span>
                  </label>
                  <input
                    className="mt-2 w-full"
                    type="range"
                    min={10}
                    max={180}
                    step={5}
                    value={filters.maxCommute}
                    onChange={(e) => setFilters({ ...filters, maxCommute: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-600">
                    Min Schools Score: <span className="font-semibold">{filters.minSchools}</span>
                  </label>
                  <input
                    className="mt-2 w-full"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={filters.minSchools}
                    onChange={(e) => setFilters({ ...filters, minSchools: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="text-xs text-stone-600">
                    Max Crime Index: <span className="font-semibold">{filters.maxCrime}</span>
                  </label>
                  <input
                    className="mt-2 w-full"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={filters.maxCrime}
                    onChange={(e) => setFilters({ ...filters, maxCrime: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>
          </div>

          {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
          {postcodeResults.length > 0 && (
            <div className="mt-6 rounded-md border border-stone-200 bg-white p-4 text-sm">
              <p className="font-semibold text-stone-900">Postcode Price Paid</p>
              <div className="mt-2 max-h-40 space-y-2 overflow-auto text-xs text-stone-700">
                {postcodeResults.slice(0, 10).map((row) => (
                  <div key={row.transaction_id} className="flex items-center justify-between">
                    <span>£{row.price.toLocaleString()}</span>
                    <span>{row.date_of_transfer}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-6 rounded-md border border-stone-200 bg-white p-4 text-sm">
            <p className="font-semibold text-stone-900">Best Postcode Sectors</p>
            <p className="mt-1 text-xs text-stone-600">
              Currently ranked by price paid. Commute, schools, and crime will plug in once datasets are ingested.
            </p>
            <div className="mt-3 max-h-56 space-y-2 overflow-auto text-xs text-stone-700">
              {scoredSectors.length === 0 && <p className="text-xs text-stone-500">No sectors loaded yet.</p>}
              {scoredSectors.map((sector) => (
                <div key={sector.sector} className="flex items-center justify-between">
                  <span className="font-medium">{sector.sector}</span>
                  <span>£{Math.round(sector.median_price).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 rounded-md border border-stone-200 bg-white p-4 text-sm">
            <p className="font-semibold text-stone-900">Price Paid Layer</p>
            <p className="mt-1 text-xs text-stone-600">{viewportNotice}</p>
            <p className="mt-1 text-xs text-stone-500">
              Current zoom: {currentZoom ? currentZoom.toFixed(1) : "--"}
            </p>
            {pricePaidPoints.length > 0 && (
              <p className="mt-2 text-xs text-stone-600">{pricePaidPoints.length} records loaded.</p>
            )}
          </div>
        </aside>

        <main className="relative">
          <MapView
            pricePaidPoints={pricePaidPoints}
            sectors={scoredSectors}
            onViewportChange={handleViewportChange}
            focusPoint={postcodeLocation}
          />
          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-stone-200 bg-white/90 px-3 py-2 text-xs text-stone-600">
            Mock API · Phase 3
          </div>
        </main>
      </div>
    </div>
  );
}
