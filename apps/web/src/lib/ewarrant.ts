// eWarrant de Testnet: certificado que emite el depositario y firma con ed25519.
// El hash que se pignora on-chain es el SHA-256 del certificado canónico, así que
// la cofirma del admin puede comprobar que el crédito usa un eWarrant real.
import { createHash } from "node:crypto";
import { Keypair } from "@agrobank/client";
import { HttpError } from "./server";

export interface EWarrant {
  version: 1;
  id: string;
  farmer: string;
  grano: "soja";
  toneladas: number;
  depositario: string;
  depositarioKey: string;
  emitido: string;
  marcoLegal: "Ley 9.643 · Decreto 640/2024";
}

export const depositarioKey = () => {
  const s = process.env.DEPOSITARIO_SECRET;
  if (!s) throw new HttpError(503, "Falta configurar DEPOSITARIO_SECRET en el servidor.");
  return Keypair.fromSecret(s);
};

/** JSON canónico: claves ordenadas, sin espacios. */
export const canonical = (w: EWarrant) =>
  JSON.stringify(Object.fromEntries(Object.entries(w).sort(([a], [b]) => a.localeCompare(b))));

export const hashOf = (w: EWarrant) => createHash("sha256").update(canonical(w)).digest("hex");

export function issue(farmer: string, toneladas: number, depositario: string) {
  const kp = depositarioKey();
  const w: EWarrant = {
    version: 1,
    id: `EW-${Date.now().toString(36).toUpperCase()}`,
    farmer,
    grano: "soja",
    toneladas,
    depositario,
    depositarioKey: kp.publicKey(),
    emitido: new Date().toISOString(),
    marcoLegal: "Ley 9.643 · Decreto 640/2024",
  };
  const hash = hashOf(w);
  const signature = kp.sign(Buffer.from(hash, "hex")).toString("base64");
  return { ewarrant: w, hash, signature };
}

/** Atestación del admin antes de cofirmar `request_loan`. */
export function verify(input: unknown, farmer: string, tonnes: number, hash: string) {
  const x = input as { ewarrant?: EWarrant; signature?: string } | undefined;
  if (!x?.ewarrant || !x.signature) throw new HttpError(400, "Falta el certificado del eWarrant firmado por el depositario.");
  const w = x.ewarrant;
  const kp = depositarioKey();
  if (w.depositarioKey !== kp.publicKey()) throw new HttpError(400, "El eWarrant no lo emitió un depositario reconocido.");
  if (hashOf(w) !== hash) throw new HttpError(400, "El hash no corresponde al certificado del eWarrant.");
  if (!kp.verify(Buffer.from(hash, "hex"), Buffer.from(x.signature, "base64"))) {
    throw new HttpError(400, "La firma del depositario no es válida.");
  }
  if (w.farmer !== farmer) throw new HttpError(400, "El eWarrant está a nombre de otro productor.");
  if (tonnes > w.toneladas) throw new HttpError(400, `El eWarrant certifica ${w.toneladas} t: no se pueden pignorar ${tonnes} t.`);
  return w;
}
