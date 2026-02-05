import { useEffect, useMemo, useState } from "react";
import { fetchFeasible, Inputs, ScoredRegion, searchRegions } from "./api/client";
import MapView from "./components/MapView";

const defaultInputs: Inputs = {
  maxMonthlyBudget: 2200,
  deposit: 60000,
  mortgageRate: 4.5,
  termYears: 30,
  maxCommuteMins: 40,
  maxCrimeIndex: 55,
};

export default function App() {
  const [inputs, setInputs] = useState<Inputs>(defaultInputs);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scoredRegions, setScoredRegions] = useState<ScoredRegion[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ScoredRegion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    setLoading(true);
    fetchFeasible(inputs)
      .then((data) => {
        if (!active) return;
        setScoredRegions(data.scored);
      })
      .catch((err) => {
        if (!active) return;
        setError(err.message || "Failed to score regions");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [inputs]);

  useEffect(() => {
    let active = true;
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return () => {
        active = false;
      };
    }
    searchRegions(searchQuery)
      .then((data) => {
        if (!active) return;
        const matched = scoredRegions.filter((item) =>
          data.results.some((region) => region.id === item.region.id)
        );
        setSearchResults(matched);
      })
      .catch(() => {
        if (!active) return;
        setSearchResults([]);
      });
    return () => {
      active = false;
    };
  }, [searchQuery, scoredRegions]);

  const feasibleRegions = useMemo(() => scoredRegions.filter((r) => r.feasible), [scoredRegions]);
  const selected = useMemo(
    () => scoredRegions.find((r) => r.region.id === selectedId),
    [scoredRegions, selectedId]
  );
  const visibleRegions = searchResults.length > 0 ? searchResults : scoredRegions;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="grid min-h-screen grid-cols-1 gap-0 lg:grid-cols-[380px_1fr]">
        <aside className="border-b border-slate-800 bg-slate-900/70 p-6 lg:border-b-0 lg:border-r">
          <div className="mb-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Phase 3</p>
            <h1 className="text-2xl font-semibold">Feasible Regions Explorer</h1>
            <p className="mt-2 text-sm text-slate-400">
              Input your constraints. We highlight regions that fit your commute, budget, and crime tolerance.
            </p>
          </div>

          <form className="space-y-4">
            <div>
              <label className="text-sm text-slate-300">Search Region (Phase 3 stub)</label>
              <input
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                type="text"
                placeholder="Try: London, Manchester, Bristol"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm text-slate-300">Max Monthly Budget (£)</label>
              <input
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                type="number"
                min={500}
                value={inputs.maxMonthlyBudget}
                onChange={(e) => setInputs({ ...inputs, maxMonthlyBudget: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="text-sm text-slate-300">Deposit (£)</label>
              <input
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                type="number"
                min={0}
                value={inputs.deposit}
                onChange={(e) => setInputs({ ...inputs, deposit: Number(e.target.value) })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-slate-300">Mortgage Rate (%)</label>
                <input
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  type="number"
                  min={0}
                  step={0.1}
                  value={inputs.mortgageRate}
                  onChange={(e) => setInputs({ ...inputs, mortgageRate: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-sm text-slate-300">Term (Years)</label>
                <input
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  type="number"
                  min={5}
                  max={40}
                  value={inputs.termYears}
                  onChange={(e) => setInputs({ ...inputs, termYears: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-slate-300">Max Commute (mins)</label>
                <input
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  type="number"
                  min={10}
                  value={inputs.maxCommuteMins}
                  onChange={(e) => setInputs({ ...inputs, maxCommuteMins: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="text-sm text-slate-300">Max Crime Index</label>
                <input
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  type="number"
                  min={0}
                  max={100}
                  value={inputs.maxCrimeIndex}
                  onChange={(e) => setInputs({ ...inputs, maxCrimeIndex: Number(e.target.value) })}
                />
              </div>
            </div>
          </form>

          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">Feasible Regions</h2>
            <div className="mt-3 space-y-3">
              {loading && <p className="text-sm text-slate-400">Scoring regions...</p>}
              {error && <p className="text-sm text-rose-300">{error}</p>}
              {!loading && !error && feasibleRegions.length === 0 && (
                <p className="text-sm text-slate-400">No regions match yet. Try relaxing constraints.</p>
              )}
              {feasibleRegions.map(({ region, payment }) => (
                <button
                  key={region.id}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                    selectedId === region.id
                      ? "border-emerald-400 bg-emerald-500/10"
                      : "border-slate-800 bg-slate-950/40 hover:border-emerald-500/60"
                  }`}
                  onClick={() => setSelectedId(region.id)}
                  type="button"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-100">{region.name}</span>
                    <span className="text-xs text-slate-400">{region.commuteMins} min commute</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    Est. £{Math.round(payment).toLocaleString()} / month · Crime {region.crimeIndex}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 rounded-md border border-slate-800 bg-slate-950/40 p-4 text-sm">
            <p className="font-semibold text-slate-100">Selected Region</p>
            {selected ? (
              <div className="mt-2 space-y-1 text-slate-300">
                <div>{selected.region.name}</div>
                <div>Avg price: £{selected.region.avgPrice.toLocaleString()}</div>
                <div>Est. monthly: £{Math.round(selected.payment).toLocaleString()}</div>
                <div>Schools score: {selected.region.schoolsScore}</div>
                <div>Employment score: {selected.region.employmentScore}</div>
              </div>
            ) : (
              <p className="mt-2 text-slate-400">Click a region on the map or list.</p>
            )}
          </div>
        </aside>

        <main className="relative">
          <MapView regions={visibleRegions} selectedId={selectedId} onSelect={setSelectedId} />
          <div className="pointer-events-none absolute left-4 top-4 rounded-md border border-slate-800 bg-slate-900/80 px-3 py-2 text-xs text-slate-300">
            Mock API · Phase 3
          </div>
        </main>
      </div>
    </div>
  );
}
