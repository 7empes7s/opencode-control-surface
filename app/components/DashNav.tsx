import { useLocation, Link } from "wouter";

const NAV = [
  { href: "/", label: "home" },
  { href: "/autopipeline", label: "pipeline" },
  { href: "/doctor", label: "doctor" },
  { href: "/models", label: "models" },
  { href: "/newsbites", label: "newsbites" },
  { href: "/infra", label: "infra" },
  { href: "/incidents", label: "incidents" },
  { href: "/opencode", label: "opencode" },
];

export function DashNav() {
  const [location] = useLocation();

  return (
    <nav className="dash-nav">
      <span className="dash-nav-brand">
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 5px var(--accent)", flexShrink: 0 }} />
        TIB
      </span>
      {NAV.map(({ href, label }) => {
        const active = href === "/" ? location === "/" : location.startsWith(href);
        return (
          <Link key={href} href={href} className={`dash-nav-link${active ? " active" : ""}`}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
