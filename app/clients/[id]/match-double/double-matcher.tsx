"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CheckCircle2, Sparkles, Loader2, ArrowRight, Database, Link2 } from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import type { Database as DB } from "@/lib/database.types";

type ClientLink = DB["public"]["Tables"]["client_links"]["Row"];

interface DoubleClient {
  id: number;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  branchId?: number;
  // Optional richer fields only present if /details endpoint was called
  primary_email?: string;
  status?: string;
  address_state?: string;
}

interface ApiResponse {
  clients: DoubleClient[];
  suggestion: { client: DoubleClient; score: number } | null;
}

export function DoubleMatcher({ clientLink }: { clientLink: ClientLink }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DoubleClient | null>(null);
  const [saving, setSaving] = useState(false);
  const [jurisdiction, setJurisdiction] = useState<"US" | "CA">(clientLink.jurisdiction);
  const [stateProvince, setStateProvince] = useState(clientLink.state_province || "");
  const [clientName, setClientName] = useState(clientLink.client_name);

  const supabase = createBrowserClient<DB>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    fetch(`/api/double/clients?qbo_realm=${clientLink.qbo_realm_id}`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        if (d.suggestion?.client) {
          setSelected(d.suggestion.client);
        }
        setLoading(false);
      })
      .catch((e) => {
        console.error("Failed to load Double clients:", e);
        setLoading(false);
      });
  }, [clientLink.qbo_realm_id]);

  const filtered = (data?.clients || []).filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  async function saveAndContinue() {
    if (!selected) return;
    setSaving(true);

    const { error } = await supabase
      .from("client_links")
      .update({
        double_client_id: String(selected.id),
        double_client_name: selected.name,
        client_name: clientName,
        jurisdiction,
        state_province: stateProvince,
      })
      .eq("id", clientLink.id);

    if (error) {
      // Translate the most common Postgres errors into plain English.
      // The legacy single-column unique on double_client_id was swapped
      // for a composite (double_client_id, qbo_realm_id) in migration
      // 23 — so the only way this fires now is if the SAME (Double
      // client + QBO realm) pair is already saved on a different row.
      const msg = error.message || "";
      const code = (error as any).code;
      let friendly: string;
      if (code === "23505" || /unique constraint|duplicate key/i.test(msg)) {
        if (/double_qbo_unique/.test(msg)) {
          friendly =
            `This Double client is already linked to this exact QBO realm in another Ironbooks record. ` +
            `Open /clients and search — you'll find an existing row with the same QBO realm ID. ` +
            `Most likely you accidentally connected the same QBO company twice.`;
        } else if (/double_client_id/.test(msg)) {
          friendly =
            `Heads up — your database still has the legacy single-column unique on double_client_id. ` +
            `Run migration 23 (scripts/migration_23_double_client_id_composite.sql) in Supabase to allow ` +
            `one Double client to link to multiple QBO realms (e.g. Baldwin's sole prop + Canadian corp).`;
        } else {
          friendly = `Save failed: ${msg}`;
        }
      } else {
        friendly = `Save failed: ${msg}`;
      }
      alert(friendly);
      setSaving(false);
      return;
    }

    router.push("/dashboard?client_linked=true");
  }

  return (
    <div>
      {/* QBO source card */}
      <div className="rounded-xl bg-white border border-gray-200 mb-4">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-3">
          <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
            <Database size={18} className="text-teal" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-navy">QuickBooks Client (connected)</h3>
            <p className="text-xs text-ink-slate">QBO Realm ID: {clientLink.qbo_realm_id}</p>
          </div>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
              Client name
            </label>
            <input
              type="text"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Jurisdiction
              </label>
              <select
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value as "US" | "CA")}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy bg-white"
              >
                <option value="US">United States</option>
                <option value="CA">Canada</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                State / Province
              </label>
              <input
                type="text"
                value={stateProvince}
                onChange={(e) => setStateProvince(e.target.value)}
                placeholder={jurisdiction === "CA" ? "SK, ON, BC..." : "TX, CA, FL..."}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Double matching card */}
      <div className="rounded-xl bg-white border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-3">
          <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
            <Link2 size={18} className="text-teal" />
          </div>
          <div>
            <h3 className="font-bold text-sm text-navy">Match in Double HQ</h3>
            <p className="text-xs text-ink-slate">Pick the matching Double client</p>
          </div>
        </div>

        <div className="p-5">
          {loading ? (
            <div className="flex items-center gap-2 py-8 justify-center text-ink-slate">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Loading Double clients...</span>
            </div>
          ) : (
            <>
              {/* Smart suggestion */}
              {data?.suggestion && !selected && (
                <div className="mb-3 p-3 rounded-lg bg-teal-lighter border border-teal-light flex items-center gap-3">
                  <Sparkles size={18} className="text-teal" />
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-navy">
                      Suggested: {data.suggestion.client.name}
                    </div>
                    <div className="text-xs text-ink-slate">
                      {Math.round(data.suggestion.score * 100)}% confidence match
                    </div>
                  </div>
                  <button
                    onClick={() => setSelected(data.suggestion!.client)}
                    className="bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-3 py-1.5 rounded-md"
                  >
                    Use match
                  </button>
                </div>
              )}

              <div className="relative mb-3">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
                <input
                  type="text"
                  placeholder="Search Double clients..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
                />
              </div>

              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {filtered.map((client) => {
                  const isSelected = selected?.id === client.id;
                  return (
                    <button
                      key={client.id}
                      onClick={() => setSelected(client)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                        isSelected
                          ? "bg-teal-lighter border-2 border-teal"
                          : "border-2 border-gray-100 hover:bg-teal-lighter"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-navy">{client.name}</div>
                        <div className="text-xs text-ink-slate">
                          ID: {client.id}{client.branchId ? ` · Branch ${client.branchId}` : ""}
                        </div>
                      </div>
                      {isSelected && <CheckCircle2 size={18} className="text-teal" />}
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <p className="text-sm text-ink-slate py-4 text-center">
                    No matching Double clients found.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <button
          onClick={saveAndContinue}
          disabled={!selected || saving || !clientName || !stateProvince}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          {saving ? "Saving..." : "Link & Continue"}
        </button>
      </div>
    </div>
  );
}
