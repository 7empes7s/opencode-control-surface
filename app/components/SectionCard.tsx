import { useState } from "react";
import { ChevronDown } from "lucide-react";

interface SectionCardProps {
  title: React.ReactNode;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  id?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export function SectionCard({
  title,
  right,
  defaultOpen = true,
  id,
  style,
  children,
}: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section-card${open ? "" : " closed"}`} id={id} style={style}>
      <div className="section-card-header sc-header" onClick={() => setOpen((o) => !o)}>
        <span className="title">{title}</span>
        <div className="sc-right">
          {right}
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            className={open ? "sc-chevron" : "sc-chevron sc-chevron-closed"}
          />
        </div>
      </div>
      {open && children}
    </div>
  );
}
