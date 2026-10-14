import { issue } from "@/lib/ewarrant";
import { HttpError, MAX_TONNES, assertAccount, fail, json } from "@/lib/server";

/** Depositario de Testnet: emite un eWarrant firmado por el grano depositado. */
export async function POST(request: Request) {
  try {
    const b = await request.json().catch(() => ({}));
    const farmer = assertAccount(b.farmer);
    const toneladas = Number(b.toneladas);
    if (!Number.isInteger(toneladas) || toneladas <= 0 || toneladas > MAX_TONNES) {
      throw new HttpError(400, `Las toneladas tienen que ser enteras, entre 1 y ${MAX_TONNES}.`);
    }
    return json(issue(farmer, toneladas, "Depositario de prueba AgroBank (Testnet)"));
  } catch (e) {
    return fail(e);
  }
}
