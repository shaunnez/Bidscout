import { fold } from "../clean.ts";
import { find, findAll, hitOf, splitLabels, sub, whole, type Found, type Hit, type Seg } from "./text.ts";

/**
 * Pulls computer details out of a lot's cleaned title and description.
 * Three description shapes seen on number8.bid:
 *  - ITAD batches:   "Type – AIO Make – HP Model – EliteOne 800 G6 Specs – Intel Core i5 10500,3.1GHz,8GB,1TB SSD Faults – …"
 *  - Labelled:       "Model: ProOne 600 G5CPU: Core i5 9500 @ 3.0ghzRAM: 16gbStorage: 500gb ssd Screen: 21.5“ …"
 *  - Free text:      "Intel Xeon Silver 4310,2.10 GHz,192 GB,2 × 1.92 TB SSD …"
 * Nothing is guessed: a value is only produced with the words it came from.
 */

export const COMPUTER_TYPES = new Set(["laptop", "desktop", "aio", "mini", "workstation", "server", "tablet", "thin-client"]);
const IT_CATEGORIES = /\b(it|computers?)\b/i;
// Words that are computers on their own; weaker ones ("desktop", "micro", "monitor") need a CPU or a computer brand too.
const STRONG_TYPES = new Set(["laptop", "tablet", "thin-client", "workstation", "aio", "server"]);

export const DEVICE_LABEL: Record<string, string> = {
  laptop: "Laptop", desktop: "Desktop", aio: "All-in-one", mini: "Mini PC", workstation: "Workstation",
  server: "Server", tablet: "Tablet", "thin-client": "Thin client", monitor: "Monitor", ram: "Memory",
  storage: "Storage", gpu: "Graphics card", networking: "Networking", printer: "Printer", phone: "Phone",
  projector: "Projector", accessory: "Accessory", nas: "NAS",
};

const TYPE_WORDS: Array<[string, RegExp]> = [
  ["thin-client", /\bthin\s*client\b/i],
  ["aio", /\b(all[\s-]*in[\s-]*one|aio|imac|proone|eliteone|thinkcentre m\d+z|ideacentre aio)\b/i],
  ["workstation", /\b(workstation|precision (?:t|tower)?\d{4}|hp z\d{1,3}\b|z\d{3} workstation)\b/i],
  ["accessory", /\b(?:server|network|comms|data)\s*(?:\/\s*\w+\s*)?(?:cabinet|rack)\b/i],
  ["server", /\b(servers?|poweredge|proliant|supermicro|rack ?mount)\b/i],
  ["laptop", /\b(laptops?|notebooks?|macbook|thinkpad|elitebook|probook|latitude|chromebook|zbook|toughbook|ideapad|vivobook|zenbook|inspiron 1\d|portege|satellite|dynabook|surface laptop)\b/i],
  ["tablet", /\b(ipads?|tablets?|surface pro|galaxy tab)\b/i],
  ["mini", /\b(mini ?pcs?|micro|tiny|nuc|mac mini|elite ?mini|thinkcentre m\d+q|prodesk \d+ g\d+ (?:dm|mini))\b/i],
  ["desktop", /\b(desktop|tower|sff|small form factor|optiplex|prodesk|elitedesk|thinkcentre|vostro|computer|pc)\b/i],
  ["monitor", /\b(monitors?|display|lcd|led screen)\b/i],
  ["ram", /\b(ram|memory|ddr[2-5])\b/i],
  ["gpu", /\b(graphics card|gpu|geforce|rtx \d{4}|gtx \d{3,4}|radeon rx)\b/i],
  ["nas", /\b(nas|synology|qnap)\b/i],
  ["storage", /\b(ssds?|hdds?|hard drives?|nvme)\b/i],
  ["networking", /\b(switch|router|firewall|access point|ubiquiti|unifi|meraki|patch panel)\b/i],
  ["printer", /\b(printer|mfp|laserjet|officejet)\b/i],
  ["phone", /\b(iphones?|smartphones?|galaxy s\d+|pixel \d)\b/i],
  ["projector", /\bprojector\b/i],
  ["accessory", /\b(keyboard|mouse|dock(?:ing station)?|charger|webcam|headset)\b/i],
];

const ITAD_TYPE: Record<string, string> = {
  aio: "aio", tower: "desktop", desktop: "desktop", sff: "desktop", mt: "desktop", laptop: "laptop",
  notebook: "laptop", micro: "mini", mini: "mini", tiny: "mini", tablet: "tablet", server: "server",
  workstation: "workstation", monitor: "monitor", "thin client": "thin-client",
};

const BRANDS = [
  "Hewlett Packard", "HP", "Dell", "Lenovo", "Apple", "Acer", "Asus", "Microsoft", "Toshiba", "Dynabook",
  "Samsung", "LG", "Fujitsu", "Panasonic", "MSI", "Gigabyte", "Razer", "Supermicro", "Cisco", "Ubiquiti",
  "Synology", "QNAP", "Netgear", "TP-Link", "Epson", "Brother", "Canon", "BenQ", "ViewSonic", "Philips",
  "AOC", "Intel", "Clone", "ASRock", "Alienware", "Huawei", "Xiaomi", "Sony", "Kingston", "Corsair", "Crucial",
  "Western Digital", "WD", "Seagate", "Nvidia", "AMD", "Logitech", "Aruba", "Juniper", "Fortinet", "Meraki",
];
const BRAND_CANON: Record<string, string> = { "hewlett packard": "HP", wd: "Western Digital" };
const IT_BRANDS = /\b(hp|dell|lenovo|apple|acer|asus|microsoft|samsung|lg|benq|viewsonic|philips|aoc|msi|gigabyte|alienware)\b/i;

export interface ComputerSummary {
  deviceType: string | null;
  isIt: boolean;
  make: string | null;
  model: string | null;
  cpu: string | null;
  cpuFamily: string | null;
  cpuGen: number | null;
  ramGb: number | null;
  storageGb: number | null;
  storageType: string | null;
  screenIn: number | null;
  gpu: string | null;
  os: string | null;
  faults: string[];
  majorFault: boolean;
  machineKey: string | null;
  looseKey: string | null;
}

export interface ParseInput {
  title: string;
  description: string;
  category: string | null;
}

export const PARSER_VERSION = "specs-v3";

// ---------------------------------------------------------------- CPU

export interface CpuHit {
  hit: Hit;
  cpu: string;
  family: string;
  gen: number | null;
}

const CPU_PATTERNS: Array<(s: Seg) => CpuHit | null> = [
  (s) => {
    const h = find(s, /\b(?:Intel\s*)?(?:Core\s*)?Ultra\s*([579])\s*[- ]?(\d{3})([A-Z]{0,2})\b/i);
    if (!h) return null;
    const [, tier, num, suf] = h.m;
    return { hit: h, cpu: `Core Ultra ${tier} ${num}${(suf ?? "").toUpperCase()}`, family: `Core Ultra ${tier}`, gen: null };
  },
  (s) => {
    const h = find(s, /\b(?:Intel\s*)?(?:Core\s*)?(i[3579])(?:\s*[- ]\s*|\s*)(\d{4,5})([A-Z]{0,2}\d?)?\b/i);
    if (!h) return null;
    const fam = h.m[1]!.toLowerCase();
    const num = h.m[2]!;
    const suf = (h.m[3] ?? "").toUpperCase();
    return { hit: h, cpu: `${fam}-${num}${suf}`, family: fam, gen: intelGen(num, suf) };
  },
  (s) => {
    const h = find(s, /\bXeon\s*(?:(Bronze|Silver|Gold|Platinum)\s*(\d{4}[A-Z]?)|(E[357])\s*-\s*(\d{4}[A-Z]?)(?:\s*(v\d))?|(E-\d{4}[A-Z]?)|(W-\d{4,5}[A-Z]?))/i);
    if (!h) return null;
    const m = h.m;
    const name = m[1] ? `Xeon ${cap(m[1])} ${m[2]}` : m[3] ? `Xeon ${m[3].toUpperCase()}-${m[4]}${m[5] ? " " + m[5].toLowerCase() : ""}` : `Xeon ${(m[6] ?? m[7])!.toUpperCase()}`;
    return { hit: h, cpu: name, family: "xeon", gen: null };
  },
  (s) => {
    const h = find(s, /\b(?:AMD\s*)?Ryzen\s*(?:TR|Threadripper)?\s*([3579])\s*(?:Pro\s*)?(\d{4})([A-Z]{0,3})\b/i);
    if (!h) return null;
    const tier = h.m[1]!;
    const num = h.m[2]!;
    // Generation is only given for Intel Core; Ryzen series numbers do not map to it.
    return { hit: h, cpu: `Ryzen ${tier} ${num}${(h.m[3] ?? "").toUpperCase()}`, family: `ryzen ${tier}`, gen: null };
  },
  (s) => {
    const h = find(s, /\bApple\s*(M[1-5])(?:\s*(Pro|Max|Ultra))?\b|\b(M[1-5])\s*(Pro|Max|Ultra)?\s*chip\b/i);
    if (!h) return null;
    const chip = (h.m[1] ?? h.m[3])!.toUpperCase();
    const tier = h.m[2] ?? h.m[4];
    return { hit: h, cpu: `Apple ${chip}${tier ? " " + cap(tier) : ""}`, family: "apple m", gen: null };
  },
  (s) => {
    const h = find(s, /\b(Celeron|Pentium(?:\s*(?:Gold|Silver))?|Atom)\s*([A-Z]?\d{3,5}[A-Z]{0,2})?\b/i);
    if (!h) return null;
    return { hit: h, cpu: `${cap(h.m[1]!)}${h.m[2] ? " " + h.m[2].toUpperCase() : ""}`, family: h.m[1]!.split(/\s/)[0]!.toLowerCase(), gen: null };
  },
  (s) => {
    const h = find(s, /\b(?:AMD\s*)?(A(?:4|6|8|9|10|12)-\d{4}[A-Z]?|GX-\d{3}[A-Z]{2}|Athlon\s*(?:Silver|Gold)?\s*\w*\d{3,4}\w*|EPYC\s*\d{4}\w*)/i);
    if (!h) return null;
    return { hit: h, cpu: `AMD ${h.m[1]!.toUpperCase().replace(/\s+/g, " ")}`, family: "amd", gen: null };
  },
  (s) => {
    const h = find(s, /\b(?:Intel\s*)?Core\s*(i[3579])\b/i);
    if (!h) return null;
    return { hit: h, cpu: `Core ${h.m[1]!.toLowerCase()}`, family: h.m[1]!.toLowerCase(), gen: null };
  },
];

/** Intel Core generation from the model number: 8500 → 8, 10500 → 10, 1240P → 12, 1065G7 → 10. */
export function intelGen(num: string, suffix = ""): number | null {
  if (num.length === 5) return Number(num.slice(0, 2));
  if (num.length === 4) {
    if (num[0] === "1" && /^[0-4]$/.test(num[1]!) && /^(G\d|P|U|H|HX|HS)?$/.test(suffix) && suffix !== "" ) return Number(num.slice(0, 2));
    return Number(num[0]);
  }
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function findCpu(segs: Seg[]): CpuHit | null {
  for (const s of segs) for (const p of CPU_PATTERNS) {
    const r = p(s);
    if (r) return r;
  }
  return null;
}

// ---------------------------------------------------------------- faults

interface FaultRule {
  tag: string;
  major: boolean;
  re: RegExp;
}

export const FAULT_LABEL: Record<string, string> = {
  "wont-boot": "Won't boot", "no-power": "No power", locked: "Locked", screen: "Screen damage",
  damaged: "Damaged", unknown: "Unknown fault / untested", "no-charger": "No charger",
  battery: "Battery fault", "no-drive": "No drive", cosmetic: "Cosmetic wear", "missing-part": "Missing part",
  "no-os": "No OS", "no-cables": "No cables",
};

const FAULTS: FaultRule[] = [
  { tag: "wont-boot", major: true, re: /\b(?:won[’']?t|will not|doesn[’']?t|does not|not|unable to)\s+(?:boot|power on|turn on|start up)\b|\bno boot\b|\bboot ?loop\b/i },
  { tag: "no-power", major: true, re: /\bno power\b(?!\s*(?:adapter|cord|supply|pack|cable|brick|lead|charger))|\bdead\b(?!\s*pixel)/i },
  { tag: "locked", major: true, re: /\b(?:bios|password|activation|icloud|mdm|account)[\s-]*lock(?:ed)?\b|\bunable to activate\b|\bfind my\b/i },
  { tag: "screen", major: true, re: /\b(?:cracked|broken|smashed|damaged|faulty)\s+(?:screen|display|lcd|glass|panel)\b|\b(?:screen|display|lcd)\s+(?:is\s+)?(?:cracked|broken|damaged?|faulty|lines|bleed)\b|\bdead pixels?\b|\bliquid\b|\bblack (?:spots?|patch)\b/i },
  { tag: "damaged", major: true, re: /\bdamaged\b|\bbroken\b/i },
  { tag: "unknown", major: true, re: /\bunknown fault\b|\buntested\b|\bnot tested\b|\bfaulty\b(?!\s*battery)|\bfor parts\b|\bparts only\b|\bspares or repair\b/i },
  { tag: "no-charger", major: false, re: /\b(?:missing|no)\s+(?:power\s+)?(?:adapter|charger|power ?supply|psu|power ?cord|power ?lead|ac adapter)s?\b/i },
  { tag: "battery", major: false, re: /\b(?:faulty|swollen|dead|bad|no|worn)\s+battery\b|\bbattery\s+(?:fault|faulty|swollen|dead|needs replac\w*|health \d+%)/i },
  { tag: "no-drive", major: false, re: /\bno\s+(?:hdd|ssd|hard\s*drives?|drives?|storage)\b|\b(?:hard\s*)?drives?\s+removed\b|\bremoved\s+(?:hard\s*)?drives?\b/i },
  { tag: "cosmetic", major: false, re: /\b(?:scratch(?:es|ed)?|dent(?:s|ed)?|blemish(?:es)?|scuff(?:s|ed)?|marks on)\b/i },
  { tag: "missing-part", major: false, re: /\bmissing\s+(?!power\b|adapter\b|charger\b)[a-z]+(?:\s+[a-z]+)?/i },
  { tag: "no-os", major: false, re: /\bno\s+(?:os|operating system)\b/i },
  { tag: "no-cables", major: false, re: /\bno\s+cables?\b/i },
];

// ---------------------------------------------------------------- main

function labelMaps(desc: Seg) {
  const itad = splitLabels(desc, ["ITAD Barcode", "Serial Number", "Type", "Make", "Model", "Specs", "Faults", "ITAD Comments"], "(?:[–—]|-(?=\\s))");
  const isItad = itad.has("Specs") && (itad.has("Make") || itad.has("Model")) && itad.size >= 3;
  const lab = splitLabels(
    desc,
    ["Model", "CPU", "Processor", "RAM", "Memory", "Storage", "Hard Drive", "Screen", "Display", "GPU", "Graphics",
      "Opitical Drive", "Optical Drive", "Webcam", "Power Cord / Adapter", "COA / Licence", "SN", "Notes", "OS",
      "Operating System", "Brand", "Make", "Type", "Condition", "Faults"],
    ":",
  );
  const compLabels = ["CPU", "Processor", "RAM", "Memory", "Storage", "Hard Drive"].filter((l) => lab.has(l)).length;
  const isLabelled = !isItad && compLabels >= 2;
  return { itad: isItad ? itad : null, lab: isLabelled ? lab : null };
}

export function parseComputer(input: ParseInput): { values: Found[]; summary: ComputerSummary } {
  const T = whole("title", input.title);
  const D = whole("description", input.description);
  const { itad, lab } = labelMaps(D);
  const method = itad ? "parser:itad" : lab ? "parser:labelled" : "parser:text";
  const values: Found[] = [];
  const add = (field: string, value: string, hit: Hit, num?: number, m = method) => {
    if (!hit.quote) return;
    values.push({ field, value, num, method: m, ...hit });
  };
  const segOf = (label: string) => itad?.get(label) ?? lab?.get(label) ?? null;
  const nonEmpty = (s: Seg | null | undefined) => (s && s.text && !/^[-–—]+$/.test(s.text) ? s : null);

  // Device type
  let deviceType: string | null = null;
  const itadType = nonEmpty(itad?.get("Type"));
  if (itadType) {
    const t = ITAD_TYPE[itadType.text.toLowerCase()];
    if (t) {
      deviceType = t;
      add("deviceType", t, hitOf(itadType, 0, itadType.text.length));
    }
  }
  if (!deviceType) {
    // A specific prefix ("Laptop - …") wins; a generic one ("Computer - …") defers to the rest of the title.
    const prefix = find(T, /^(laptops?|notebooks?|all in one pcs?|aio|tablets?|ipads?|servers?|monitors?|workstations?|memory|ram|projectors?|hard drives?|ssds?|printers?|phones?|iphones?)\s*[-–:]/i, 1);
    const scan = (s: Seg) => {
      for (const [t, re] of TYPE_WORDS) {
        const h = find(s, re);
        if (h) return { t, h };
      }
      return null;
    };
    const fromPrefix = prefix ? scan({ source: "title", text: prefix.quote, offset: prefix.start }) : null;
    const r = fromPrefix ?? scan(T);
    if (r) {
      deviceType = r.t;
      add("deviceType", r.t, r.h, undefined, "parser:text");
    }
  }

  // Make
  let make: string | null = null;
  const brandRe = new RegExp(`\\b(${BRANDS.map((b) => b.replace(/[-.]/g, "\\$&")).join("|")})\\b`, "i");
  const makeSeg = nonEmpty(segOf("Make")) ?? nonEmpty(lab?.get("Brand"));
  let makeHit = makeSeg ? find(makeSeg, brandRe) ?? { ...hitOf(makeSeg, 0, makeSeg.text.length), m: null } : null;
  if (!makeHit) makeHit = find(T, brandRe);
  if (makeHit) {
    const raw = makeHit.quote.trim();
    const known = BRANDS.find((b) => b.toLowerCase() === raw.toLowerCase());
    make = BRAND_CANON[raw.toLowerCase()] ?? known ?? raw;
    add("make", make, makeHit);
  }

  // Model
  let model: string | null = null;
  const modelSeg = nonEmpty(segOf("Model"));
  if (modelSeg) {
    let s = modelSeg;
    if (make && s.text.toLowerCase().startsWith(make.toLowerCase() + " ")) s = sub(s, make.length, s.text.length);
    const paren = s.text.search(/\s*\([^)]*\)\s*$/);
    if (paren > 0) s = sub(s, 0, paren);
    const typeTail = find(s, /\s*[-–(]?\s*\b(laptop|desktop|tower|aio|computer|pc|tablet|workstation)\)?\s*$/i);
    const end = typeTail ? typeTail.start - s.offset : s.text.length;
    const m = sub(s, 0, end);
    if (m.text) {
      model = m.text;
      add("model", model, hitOf(m, 0, m.text.length));
    }
  } else if (makeHit && makeHit.source === "title") {
    const after = makeHit.end;
    const rest = input.title.slice(after);
    const stop = rest.search(/\s[-–]\s|,|\(|\||$/);
    let seg = sub(T, after, after + stop);
    const typeTail = find(seg, /\s*\b(laptop|notebook|desktop|tower|aio|all in one|computer|pc|tablet|server|workstation|monitor|thin client)\b.*$/i);
    if (typeTail) seg = sub(seg, 0, typeTail.start - seg.offset);
    if (seg.text && seg.text.length <= 40) {
      model = seg.text;
      add("model", model, hitOf(seg, 0, seg.text.length), undefined, "parser:text");
    }
  }

  // CPU (spec fields first, then title, then the whole description)
  const cpuSegs = [segOf("Specs"), segOf("CPU"), segOf("Processor"), T, D].filter(Boolean) as Seg[];
  const cpu = findCpu(cpuSegs);
  if (cpu) {
    add("cpu", cpu.cpu, cpu.hit);
    add("cpuFamily", cpu.family, cpu.hit);
    if (cpu.gen !== null) add("cpuGen", String(cpu.gen), cpu.hit, cpu.gen);
  }

  // RAM
  let ramGb: number | null = null;
  const ramSeg = nonEmpty(segOf("RAM")) ?? nonEmpty(lab?.get("Memory"));
  const specs = nonEmpty(itad?.get("Specs"));
  let ramHit: (Hit & { m: RegExpExecArray }) | null = null;
  const flashOnly = deviceType === "phone" || deviceType === "tablet";
  let kit: { n: number; hit: Hit } | null = null;
  if (deviceType === "ram") {
    const k = find(T, /\b(\d)\s*[x×]\s*(\d{1,3})\s*GB\b/i) ?? find(D, /\b(\d)\s*[x×]\s*(\d{1,3})\s*GB\b/i);
    if (k) kit = { n: Number(k.m[1]) * Number(k.m[2]), hit: k };
  }
  if (ramSeg) ramHit = find(ramSeg, /(\d{1,4})\s*gb\b/i);
  if (!ramHit && specs && !flashOnly) {
    for (const tok of findAll(specs, /[^,]+/)) {
      const t = find({ source: tok.source, text: tok.quote, offset: tok.start }, /^\s*(\d{1,4})\s*GB\s*$/i);
      if (t) {
        ramHit = t;
        break;
      }
    }
  }
  const free = [T, D];
  for (const s of free) {
    if (ramHit) break;
    ramHit =
      find(s, /\b(\d{1,4})\s*GB\s*(?:of\s*)?(?:RAM|DDR\d\w*|memory|LPDDR\d\w*)\b/i) ??
      find(s, /\b(\d{1,3})\s*GB\s*[,/]\s*\d+(?:\.\d+)?\s*(?:GB|TB)\s*(?:SSD|HDD|NVMe|eMMC)/i) ??
      (deviceType === "ram" ? find(s, /\b(\d{1,4})\s*GB\b/i) : null);
    if (flashOnly && ramHit && !/ram|ddr|memory/i.test(ramHit.quote)) ramHit = null;
  }
  if (kit) {
    ramGb = kit.n;
    add("ramGb", `${kit.n} GB`, kit.hit, kit.n);
  } else if (ramHit && !(flashOnly && !ramSeg)) {
    const n = Number(ramHit.m[1]);
    if (n >= 1 && n <= 4096) {
      ramGb = n;
      add("ramGb", `${n} GB`, ramHit, n);
    }
  }

  // Storage
  const storageSegs = [nonEmpty(segOf("Storage")), nonEmpty(lab?.get("Hard Drive")), specs].filter(Boolean) as Seg[];
  const scanStorage = storageSegs.length ? storageSegs : [T, D];
  let storageGb: number | null = null;
  let storageType: string | null = null;
  const drives: Array<{ gb: number; type: string; hit: Hit }> = [];
  for (const s of scanStorage) {
    for (const h of findAll(s, /(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(GB|TB)\s*(?:of\s*)?(NVMe\s*SSD|M\.2\s*SSD|SSD|SSHD|HDD|Hard\s*Drive|HD\b|NVMe|eMMC|Flash)/gi)) {
      const count = h.m[1] ? Number(h.m[1]) : 1;
      const gb = Number(h.m[2]) * (h.m[3]!.toUpperCase() === "TB" ? 1000 : 1) * count;
      const word = h.m[4]!.toLowerCase();
      const type = /ssd|nvme/.test(word) ? "ssd" : /emmc|flash/.test(word) ? "emmc" : "hdd";
      drives.push({ gb, type, hit: h });
    }
    if (drives.length) break;
  }
  const labelledStorage = [nonEmpty(segOf("Storage")), nonEmpty(lab?.get("Hard Drive"))].filter(Boolean) as Seg[];
  if (!drives.length && flashOnly) {
    // Phones and tablets: "64 GB" is the flash capacity
    const h = find(T, /\b(\d{2,4})\s*GB\b/i) ?? (specs ? find(specs, /^\s*(\d{2,4})\s*GB\b/i) : null);
    if (h) drives.push({ gb: Number(h.m[1]), type: "emmc", hit: h });
  }
  if (!drives.length && labelledStorage.length) {
    // "Storage: 500gb" without a type word
    for (const s of labelledStorage) {
      const h = find(s, /(\d+(?:\.\d+)?)\s*(GB|TB)\b/i);
      if (h) drives.push({ gb: Number(h.m[1]) * (h.m[2]!.toUpperCase() === "TB" ? 1000 : 1), type: "unknown", hit: h });
      if (drives.length) break;
    }
  }
  if (drives.length) {
    storageGb = drives.reduce((a, d) => a + d.gb, 0);
    storageType = drives.some((d) => d.type === "ssd") ? "ssd" : drives[0]!.type;
    drives.forEach((d) => add("storage", `${d.gb >= 1000 ? d.gb / 1000 + " TB" : d.gb + " GB"} ${d.type.toUpperCase()}`, d.hit, d.gb));
  } else {
    const none = find(specs ?? T, /\bNo\s+(?:HDD|SSD|Hard\s*Drives?|Drives?|Storage)\b/i) ?? find(T, /\bNo\s+(?:HDD|SSD|Hard\s*Drives?|Drives?)\b/i);
    if (none) {
      storageGb = 0;
      storageType = "none";
      add("storage", "None", none, 0);
    }
  }

  // Screen
  let screenIn: number | null = null;
  const screenSegs = [nonEmpty(segOf("Screen")), nonEmpty(lab?.get("Display")), specs, T].filter(Boolean) as Seg[];
  for (const s of screenSegs) {
    const h = find(s, /\b(\d{1,2}(?:\.\d)?)\s*(?:-\s*)?(?:inch(?:es)?|in\b|"|”|“|''|’’|‘‘|’‘|‘’)/i);
    if (h) {
      const n = Number(h.m[1]);
      if (n >= 7 && n <= 100) {
        screenIn = n;
        add("screenIn", `${n}"`, h, n);
        break;
      }
    }
  }

  // GPU (discrete names only; "integrated" is not a GPU spec)
  let gpu: string | null = null;
  const gpuRe = /\b(?:NVIDIA\s*)?(?:GeForce\s*)?(?:RTX\s*A?\d{3,4}(?:\s*Ti|\s*Super)?|GTX\s*\d{3,4}(?:\s*Ti)?|Quadro\s*[A-Z]?\d{3,4}\w*|Tesla\s*[A-Z]\d+)\b|\bRadeon\s*(?:Pro\s*)?(?:RX\s*)?[A-Z]?\d{3,4}\w*\b|\bIntel\s*Arc\s*A\d{3}\w*\b/i;
  for (const s of [nonEmpty(segOf("GPU")), nonEmpty(lab?.get("Graphics")), specs, T, D].filter(Boolean) as Seg[]) {
    const h = find(s, gpuRe);
    if (h) {
      gpu = h.quote.replace(/\s+/g, " ");
      add("gpu", gpu, h);
      break;
    }
  }

  // OS
  let os: string | null = null;
  for (const s of [nonEmpty(segOf("OS")), nonEmpty(lab?.get("Operating System")), specs, D, T].filter(Boolean) as Seg[]) {
    const h = find(s, /\b(Windows\s*1[01]\s*(?:Pro|Home|Enterprise|Education)?|Windows\s*(?:Pro|Home)|Win\s?1[01]\s*(?:Pro|Home)?|macOS(?:\s+(?:Big Sur|High Sierra|Sierra|Catalina|Mojave|Monterey|Ventura|Sonoma|Sequoia|Tahoe))?|Chrome\s?OS|Ubuntu|Linux|No\s+(?:OS|Operating System))\b/i);
    if (h) {
      os = h.quote.replace(/\s+/g, " ");
      add("os", os, h);
      break;
    }
  }

  // Faults
  const faults: string[] = [];
  const faultSegs = [nonEmpty(itad?.get("Faults")), nonEmpty(itad?.get("ITAD Comments")), nonEmpty(lab?.get("Notes")), nonEmpty(lab?.get("Condition")), T, D].filter(Boolean) as Seg[];
  for (const rule of FAULTS) {
    for (const s of faultSegs) {
      const h = find(s, rule.re);
      if (h) {
        faults.push(rule.tag);
        add("fault", FAULT_LABEL[rule.tag] ?? rule.tag, h, undefined, "parser:faults");
        break;
      }
    }
  }
  if (faults.includes("screen") || faults.includes("wont-boot")) {
    const i = faults.indexOf("damaged");
    if (i >= 0 && !/\bdamaged\b/i.test(input.title)) faults.splice(i, 1);
  }
  if (itad && !faults.length) {
    const fs = itad.get("Faults");
    if (fs && !nonEmpty(fs)) add("faultsListed", "None listed", fs.labelHit, undefined, "parser:itad");
  }
  const majorFault = faults.some((t) => FAULTS.find((f) => f.tag === t)?.major);

  const itBrand = !!make && (IT_BRANDS.test(make) || make === "Clone" || make === "Intel");
  const isIt =
    !!itad || !!lab ||
    (!!input.category && IT_CATEGORIES.test(input.category)) ||
    (!!deviceType && (STRONG_TYPES.has(deviceType) || !!cpu || itBrand));

  const summary: ComputerSummary = {
    deviceType: isIt ? deviceType : null,
    isIt,
    make,
    model,
    cpu: cpu?.cpu ?? null,
    cpuFamily: cpu?.family ?? null,
    cpuGen: cpu?.gen ?? null,
    ramGb,
    storageGb,
    storageType,
    screenIn,
    gpu,
    os,
    faults,
    majorFault,
    machineKey: null,
    looseKey: null,
  };
  summary.machineKey = machineKey(summary);
  summary.looseKey = looseKey(summary);
  return { values: isIt ? values : values.filter((v) => v.field === "fault"), summary };
}

const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();

const ramBand = (gb: number | null) =>
  gb === null ? "ram?" : gb <= 4 ? "ram<=4" : gb <= 8 ? "ram8" : gb <= 16 ? "ram16" : gb <= 32 ? "ram32" : "ram64+";

const storageBand = (s: ComputerSummary) =>
  s.storageGb === null ? "st?" : s.storageGb === 0 ? "st0" : `${s.storageType}${s.storageGb < 200 ? "<200" : s.storageGb < 400 ? "256" : s.storageGb < 800 ? "512" : s.storageGb < 1500 ? "1t" : "2t+"}`;

/** Same machine and spec: make, model, CPU, RAM and storage class. */
export function machineKey(s: ComputerSummary): string | null {
  if (!s.isIt || !s.deviceType) return null;
  if (COMPUTER_TYPES.has(s.deviceType)) {
    if (!s.model && !s.cpu) return null;
    return ["m", s.deviceType, norm(s.make ?? "-"), norm(s.model ?? "-"), norm(s.cpu ?? "-"), ramBand(s.ramGb), storageBand(s)].join("|");
  }
  if (!s.make || !s.model) return null;
  return ["m", s.deviceType, norm(s.make), norm(s.model), s.screenIn ?? "-"].join("|");
}

/** Similar machines: type, CPU family and generation, RAM band and storage type. */
export function looseKey(s: ComputerSummary): string | null {
  if (!s.isIt || !s.deviceType || !COMPUTER_TYPES.has(s.deviceType) || !s.cpuFamily) return null;
  return ["l", s.deviceType, s.cpuFamily, `g${s.cpuGen ?? "?"}`, ramBand(s.ramGb), s.storageType ?? "st?"].join("|");
}

/** For every other lot: the same title, tidied (liquidation sales repeat stock lines). */
export function titleKey(title: string): string | null {
  const t = norm(title.replace(/^\s*\d+\s*[x×]\s*/i, ""));
  return t.length >= 6 ? `t|${t}` : null;
}
