"use client";

import { useRef, useState } from "react";
import { FileText, Upload, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { CLIENT_UPLOADS_BUCKET } from "@/lib/client-comms";

type Done = { name: string; filedAs: string };

/**
 * Dedicated statement upload for the portal Messages page. The client drops
 * their bank / credit-card / loan statement PDFs here; each is read by AI,
 * matched to the right account, renamed, and filed to their bookkeeper — no
 * need to label or explain which account it is.
 */
export function StatementUploadPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const files = Array.from(fileList);
    const supabase = createBrowserSupabase();
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setBusy(files.length > 1 ? `Reading ${i + 1} of ${files.length}…` : "Reading your statement…");
        const urlRes = await fetch("/api/portal/messages/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: f.name, size: f.size, content_type: f.type }),
        });
        const urlJson = await urlRes.json();
        if (!urlRes.ok) throw new Error(urlJson.error || `Couldn't prepare upload for ${f.name}`);

        const { error: upErr } = await supabase.storage
          .from(CLIENT_UPLOADS_BUCKET)
          .uploadToSignedUrl(urlJson.path, urlJson.token, f);
        if (upErr) throw new Error(`Upload failed for ${f.name}: ${upErr.message}`);

        const procRes = await fetch("/api/portal/statements/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: urlJson.path, name: f.name }),
        });
        const procJson = await procRes.json();
        if (!procRes.ok) throw new Error(procJson.error || `Couldn't read ${f.name}`);
        setDone((prev) => [...prev, { name: f.name, filedAs: procJson.display_name || f.name }]);
      }
    } catch (e: any) {
      setError(e?.message || "Something went wrong — try again");
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-teal/10 flex-shrink-0">
            <FileText size={18} className="text-teal" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-navy text-sm">Upload bank statements</h3>
            <p className="text-xs text-ink-slate mt-0.5 leading-relaxed">
              Drop your bank, credit-card or loan statement PDFs — we'll automatically figure out which account each one is and file it for your bookkeeper.
            </p>
          </div>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 bg-teal hover:bg-teal-dark disabled:opacity-60 text-white text-sm font-semibold px-3 py-2 rounded-lg flex-shrink-0"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {busy && (
        <div className="mt-3 flex items-center gap-2 text-sm text-teal-dark bg-teal/5 border border-teal/20 rounded-lg px-3 py-2">
          <Loader2 size={14} className="animate-spin" /> {busy}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-start gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}
      {done.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {done.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <CheckCircle2 size={14} className="text-emerald-600 flex-shrink-0" />
              <span className="truncate"><strong>{d.filedAs}</strong> — filed for your bookkeeper</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
