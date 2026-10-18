
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
  /** The listing's description, for a model number (products that aren't computers). */
  description?: string;
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
  if (l.is_it) return l.title.replace(/\s+[-–]\s+[^-–]*$/, "").replace(/\b(?:unreserved|qty\s*\d+)\b/gi, "").replace(/\s{2,}/g, " ").trim();
  return productQuery(l.title, l.description ?? "");
}

/** Bulk, pallet and mixed lots: nothing specific enough to price. */
export const isBulkLot = (title: string) =>
  /\b(?:pallets? (?:lot|of|load)|bulk|assorted|mixed|miscellaneous|misc|contents of|box(?:es)? of|lots? of|job lot|bundle of)\b/i.test(title);

const MODEL_LABEL = /\b(?:model(?:\s*(?:no\.?|number))?|part\s*(?:no\.?|number)|p\/n|pn|sku|mpn)\s*[:–—-]?\s*([A-Z0-9][A-Za-z0-9./-]{2,}[A-Za-z0-9])/i;
/** Capitals and digits together, like SHI2000-22, SOFAR4000TLM or WS408DT. */
const MODEL_TOKEN = /\b(?=[A-Z0-9./-]*\d)(?=[A-Z0-9./-]*[A-Z])[A-Z0-9][A-Z0-9./-]{3,}[A-Z0-9]\b/g;
/** Sizes, ratings and counts, not models: 400W, 12V, 2000VA, 100AH, 6X, L1480 (a length). */
const NOT_MODEL = /^(?:\d+(?:\.\d+)?(?:W|KW|KWH|VA|KVA|V|VAC|VDC|A|AH|MAH|HZ|MM|CM|M|KG|L|GB|TB|MB|MP|IN|PCS|X)|\d+X\d+\S*|[A-Z]{1,2}\d{1,2}|[LWHD]\d{2,4}(?:MM)?)$/;

/** A size, rating or count (400W, 18V, 2000VA, L1480), never a model number. */
export const isRating = (word: string) => NOT_MODEL.test(word.toUpperCase());

/** A product's model number: a labelled one ("Model – SHI2000-22") first, else a model-like code. */
export function modelNumber(description: string, title = ""): string | null {
  const labelled = MODEL_LABEL.exec(description) ?? MODEL_LABEL.exec(title);
  if (labelled && /\d/.test(labelled[1]!)) return labelled[1]!.replace(/[./-]+$/, "");
  for (const text of [description, title])
    for (const m of text.matchAll(MODEL_TOKEN)) if (!NOT_MODEL.test(m[0])) return m[0];
  return null;
}

const NOT_BRAND = /^(?:the|a|an|pair|set|large|small|new|used|heavy|office|white|black|grey|gray|wooden|wood|steel|metal|plastic|portable|commercial|industrial|electric|digital|vintage|assorted|bulk|box|pallet|lot|\d.*)$/i;

/**
 * What to search for a product that isn't a computer: brand and model number when the listing
 * has one ("EPEVER SHI2000-22"), else the tidied title. Bulk and mixed lots get nothing.
 */
export function productQuery(title: string, description = ""): string {
  if (isBulkLot(title)) return "";
  const name = title.replace(/^\d+\s*x\s+/i, "").replace(/\s*[-–]\s*(?:total\s+)?(?:wholesale|rrp|retail)\b.*$/i, "").trim();
  const model = modelNumber(description, name);
  const first = name.split(/\s+/)[0] ?? "";
  const brand = first && !NOT_BRAND.test(first) && /^[A-Z]/.test(first) ? first : null;
  if (model) {
    if (brand && !model.toLowerCase().includes(brand.toLowerCase())) return `${brand} ${model}`;
    return brand ? model : `${name.split(/\s+/).slice(0, 3).join(" ")} ${model}`;
  }
  return name.replace(/\b(?:unreserved|qty\s*\d+)\b/gi, "").replace(/\s{2,}/g, " ").split(/\s+/).slice(0, 7).join(" ").trim();
}
