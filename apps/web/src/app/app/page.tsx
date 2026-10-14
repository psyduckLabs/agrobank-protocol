import Dashboard from "../dashboard";

export default function AppPage() {
  return (
    <>
      <nav className="topbar">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6 text-sm">
          <a href="/" style={{ color: "var(--ink)", fontFamily: "var(--font-display)", fontSize: 24 }}>AgroBank</a>
          <a href="/">Inicio</a>
          <a href="/#pruebas">Pruebas</a>
          <a href="/demo/">Prototipo simulado</a>
          <a href="https://github.com/psyduckLabs/agrobank-protocol" target="_blank" rel="noopener" className="ml-auto">GitHub</a>
        </div>
      </nav>
      <Dashboard />
    </>
  );
}
