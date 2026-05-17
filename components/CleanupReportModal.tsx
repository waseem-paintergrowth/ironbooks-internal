"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, FileText, Download, Loader2 } from "lucide-react";

interface Props {
  clientId: string;
  clientName: string;
  onClose: () => void;
}

/**
 * Modal lets the bookkeeper pick a date range and download the branded
 * cleanup-summary PDF for one client. Defaults to the past 30 days.
 * Renders via React Portal to escape any nested stacking context.
 */
export function CleanupReportModal({ clientId, clientName, onClose }: Props) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const [start, setStart] = useState<string>(iso(thirtyDaysAgo));
  const [end, setEnd] = useState<string>(iso(today));
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string>("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleDownload() {
    setDownloading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/reports/cleanup/${clientId}?start=${start}&end=${end}`
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Server sets Content-Disposition with a nice filename; the browser
      // will honor it, but we set a fallback here for safety.
      a.download = `Ironbooks Cleanup — ${clientName} — ${start}_${end}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  }

  if (!mounted) return null;

  const content = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(15, 31, 46, 0.6)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full flex flex-col relative"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy flex items-center gap-2">
              <FileText size={18} className="text-teal" />
              Cleanup Report
            </h3>
            <p className="text-xs text-ink-slate mt-1">
              Download a branded PDF summarizing what was cleaned up for{" "}
              <strong className="text-navy">{clientName}</strong>. Pick the date range to cover.
            </p>
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                Start date
              </label>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
              />
            </div>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-slate mb-1">
                End date
              </label>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal outline-none text-sm text-navy"
              />
            </div>
          </div>

          <div className="p-3 bg-teal-lighter border border-teal/30 rounded-lg text-xs text-navy leading-relaxed">
            Includes every COA change, transaction categorization, and Stripe reconciliation that
            was <strong>executed</strong> for this client during the date range. Generates a 4–5
            page PDF you can attach to the client email.
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
          <button
            onClick={onClose}
            className="text-sm font-semibold text-ink-slate hover:text-navy"
          >
            Cancel
          </button>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            {downloading ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Building PDF…
              </>
            ) : (
              <>
                <Download size={14} /> Download PDF
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
