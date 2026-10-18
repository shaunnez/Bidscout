import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * Content-addressed, write-once store for response bodies (gzip on disk).
 * The ref is the SHA-256 of the uncompressed bytes; a file is never overwritten,
 * and every read re-checks the hash.
 */
export class ObjectStore {
  constructor(private root: string) {}

  /** Fails fast, with the reason, if responses can't be stored (e.g. a volume the app can't write to). */
  checkWritable() {
    const dir = path.join(this.root, "objects");
    const probe = path.join(dir, `.write-check-${process.pid}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
    } catch (e) {
      throw new Error(`Cannot write stored responses to ${dir}: ${(e as Error).message}`);
    }
  }

  private file(hash: string) {
    return path.join(this.root, "objects", hash.slice(0, 2), `${hash}.gz`);
  }

  put(body: Buffer): { ref: string; hash: string } {
    const hash = sha256(body);
    const file = this.file(hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, zlib.gzipSync(body), { flag: "wx" });
      try {
        fs.linkSync(tmp, file); // fails if another writer got there first; same bytes either way
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        fs.unlinkSync(tmp);
      }
    }
    return { ref: hash, hash };
  }

  get(ref: string): Buffer {
    const body = zlib.gunzipSync(fs.readFileSync(this.file(ref)));
    if (sha256(body) !== ref) throw new Error(`Stored object ${ref} failed its hash check`);
    return body;
  }
}
