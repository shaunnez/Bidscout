
/** The lot fields lookupQuery reads. */
export interface LookupLot {
  is_it: boolean;
  make: string | null;
  model: string | null;
  cpu: string | null;
  title: string;
  ram_gb: number | null;
  storage_gb: number | null;
  storage_type: string | null;
  device_type: string | null;
}

/** What to search other sites for: make, model and CPU for computers, else the tidied title. */
export function lookupQuery(l: LookupLot) {
  // A clone or unbranded machine is best priced by its parts.
  if (l.is_it && l.cpu && (!l.model || /^clone$/i.test(l.make ?? "") || l.model.length <= 3)) {
    const storage = l.storage_gb ? `${l.storage_gb >= 1000 ? l.storage_gb / 1000 + "TB" : l.storage_gb + "GB"}${l.storage_type === "ssd" ? " SSD" : ""}` : null;
    return [l.cpu, l.ram_gb ? `${l.ram_gb}GB` : null, storage, l.device_type].filter(Boolean).join(" ");
  }
  if (l.is_it && l.model) {
    const make = l.make && !l.model.toLowerCase().includes(l.make.toLowerCase()) ? l.make : null;
    return [make, l.model, l.cpu && /\d{3}/.test(l.cpu) ? l.cpu : null].filter(Boolean).join(" ");
  }
  return l.title.replace(/\s+[-–]\s+[^-–]*$/, "").replace(/\b(?:unreserved|qty\s*\d+)\b/gi, "").replace(/\s{2,}/g, " ").trim();
}
