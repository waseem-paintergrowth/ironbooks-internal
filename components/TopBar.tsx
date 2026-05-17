export function TopBar({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-8 py-5 sticky top-0 z-10 bg-white border-b border-gray-200">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy" style={{ letterSpacing: "-0.02em" }}>
          {title}
        </h1>
        {subtitle && <p className="text-sm mt-0.5 text-ink-slate">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
