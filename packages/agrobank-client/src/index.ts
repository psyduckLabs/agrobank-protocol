import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const Errors = {
  1: {message:"NotInitialized"},
  2: {message:"InvalidAmount"},
  3: {message:"InvalidRate"},
  4: {message:"InvalidExpiry"},
  5: {message:"LoanNotFound"},
  6: {message:"LoanNotActive"},
  7: {message:"NotBorrower"},
  8: {message:"WarrantAlreadyPledged"},
  9: {message:"InsufficientLiquidity"},
  10: {message:"Undercollateralized"},
  11: {message:"NotLiquidatable"},
  12: {message:"MathOverflow"},
  13: {message:"NoShares"},
  14: {message:"StalePrice"},
  15: {message:"InvalidPrice"},
  16: {message:"WrongFeed"},
  17: {message:"NothingToClaim"},
  18: {message:"AlreadyInitialized"},
  19: {message:"InsufficientShares"}
}


export interface Config {
  admin: string;
  /**
 * Contrato verificador de Pyth Pro.
 */
pyth_verifier: string;
  /**
 * Feed ID de Pyth para la soja.
 */
soy_feed_id: u32;
  /**
 * Billetera de la tesorería de AgroBank (recibe el spread directo).
 */
treasury: string;
  /**
 * Contrato SAC de USDC.
 */
usdc: string;
}

export type LoanStatus = {tag: "Active", values: void} | {tag: "Repaid", values: void} | {tag: "Defaulted", values: void};





/**
 * Registro por préstamo: respaldo 1:1 con el eWarrant [Decreto 640/2024].
 */
export interface LoanAssignment {
  /**
 * Toneladas de soja que respaldan el eWarrant (necesario para valuar el ratio).
 */
collateral_tonnes: i128;
  /**
 * Hash SHA-256 del eWarrant físico/legal [Decreto 640/2024].
 */
e_warrant_hash: Buffer;
  /**
 * Ledger de vencimiento (fin de campaña).
 */
expiry_ledger: u32;
  /**
 * Billetera del agricultor.
 */
farmer_address: string;
  /**
 * Tasa activa en bps (1800 = 18%).
 */
interest_rate_bps: u32;
  /**
 * Tasa pasiva a inversores en bps (1200 = 12%).
 */
investor_yield_bps: u32;
  /**
 * Principal prestado, en USDC (7 decimales).
 */
principal_usd: i128;
  /**
 * Ledger de originación (inicio del devengo).
 */
start_ledger: u32;
  status: LoanStatus;
}



export interface InvestorPosition {
  /**
 * Rendimiento ya devengado y aún no cobrado.
 */
pending_yield: i128;
  /**
 * shares * acc_yield_per_share / ACC_PRECISION al último movimiento.
 */
reward_debt: i128;
  /**
 * Participación (1 USDC depositado = 1 unidad).
 */
shares: i128;
}



export interface Client {
  /**
   * Construct and simulate a get_loan transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_loan: ({loan_id}: {loan_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<LoanAssignment>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Result<Config>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Configura el protocolo. Se puede ejecutar UNA sola vez; ejecutarla en la
   * misma secuencia de comandos que el deploy y verificar con `get_config`.
   */
  initialize: ({admin, usdc, treasury, pyth_verifier, soy_feed_id}: {admin: string, usdc: string, treasury: string, pyth_verifier: string, soy_feed_id: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a pool_stats transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * (total_shares, total_lent, acc_yield_per_share)
   */
  pool_stats: (options?: MethodOptions) => Promise<AssembledTransaction<readonly [i128, i128, i128]>>

  /**
   * Construct and simulate a repay_loan transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * En UNA transacción, desde la billetera del agricultor:
   * (a) capital + interés pasivo (12% TNA) → pool de inversores (este contrato)
   * (b) spread (6% TNA = activa - pasiva)  → billetera de tesorería
   * Si cualquiera de las dos transferencias falla, revierte todo.
   */
  repay_loan: ({farmer, loan_id}: {farmer: string, loan_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a claim_yield transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Cobra el rendimiento devengado (viene exclusivamente de intereses repagados).
   */
  claim_yield: ({investor}: {investor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a get_investor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_investor: ({investor}: {investor: string}, options?: MethodOptions) => Promise<AssembledTransaction<InvestorPosition>>

  /**
   * Construct and simulate a request_loan transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Origina un préstamo. Requiere firma del agricultor y del admin (el admin
   * atestigua score de Cartas de Porte y validez del eWarrant fuera de la cadena).
   * Bloquea el hash del eWarrant (un hash = un préstamo) y verifica on-chain el
   * ratio del 130% con el precio de Pyth.
   */
  request_loan: ({farmer, principal, collateral_tonnes, expiry_ledger, e_warrant_hash, price_update}: {farmer: string, principal: i128, collateral_tonnes: i128, expiry_ledger: u32, e_warrant_hash: Buffer, price_update: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a deposit_liquidity transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Recibe USDC del inversor vía SAC (`token::Client`), emite shares 1:1 y
   * registra su rendimiento acumulado. Devuelve el rendimiento aún no cobrado.
   */
  deposit_liquidity: ({investor, amount}: {investor: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a withdraw_liquidity transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Retira capital no prestado: `amount <= shares propias` y
   * `amount <= total_shares - total_lent` (liquidez disponible en el pool).
   */
  withdraw_liquidity: ({investor, amount}: {investor: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a liquidate_collateral transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permisionless (cualquier keeper). Marca el crédito como `Defaulted` si:
   * * venció `expiry_ledger` sin repago (no requiere oráculo), o
   * * el valor del colateral, según Pyth, cae bajo el 130% del principal.
   * `price_update` es el payload firmado (modelo pull) que se verifica on-chain
   * mediante cross-contract call al verificador de Pyth.
   * Solo cambia el estado: la ejecución física del eWarrant ocurre off-chain.
   */
  liquidate_collateral: ({loan_id, price_update}: {loan_id: u64, price_update: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<LoanStatus>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAEwAAAAAAAAAOTm90SW5pdGlhbGl6ZWQAAAAAAAEAAAAAAAAADUludmFsaWRBbW91bnQAAAAAAAACAAAAAAAAAAtJbnZhbGlkUmF0ZQAAAAADAAAAAAAAAA1JbnZhbGlkRXhwaXJ5AAAAAAAABAAAAAAAAAAMTG9hbk5vdEZvdW5kAAAABQAAAAAAAAANTG9hbk5vdEFjdGl2ZQAAAAAAAAYAAAAAAAAAC05vdEJvcnJvd2VyAAAAAAcAAAAAAAAAFVdhcnJhbnRBbHJlYWR5UGxlZGdlZAAAAAAAAAgAAAAAAAAAFUluc3VmZmljaWVudExpcXVpZGl0eQAAAAAAAAkAAAAAAAAAE1VuZGVyY29sbGF0ZXJhbGl6ZWQAAAAACgAAAAAAAAAPTm90TGlxdWlkYXRhYmxlAAAAAAsAAAAAAAAADE1hdGhPdmVyZmxvdwAAAAwAAAAAAAAACE5vU2hhcmVzAAAADQAAAAAAAAAKU3RhbGVQcmljZQAAAAAADgAAAAAAAAAMSW52YWxpZFByaWNlAAAADwAAAAAAAAAJV3JvbmdGZWVkAAAAAAAAEAAAAAAAAAAOTm90aGluZ1RvQ2xhaW0AAAAAABEAAAAAAAAAEkFscmVhZHlJbml0aWFsaXplZAAAAAAAEgAAAAAAAAASSW5zdWZmaWNpZW50U2hhcmVzAAAAAAAT",
        "AAAAAQAAAAAAAAAAAAAABkNvbmZpZwAAAAAABQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAIUNvbnRyYXRvIHZlcmlmaWNhZG9yIGRlIFB5dGggUHJvLgAAAAAAAA1weXRoX3ZlcmlmaWVyAAAAAAAAEwAAAB1GZWVkIElEIGRlIFB5dGggcGFyYSBsYSBzb2phLgAAAAAAAAtzb3lfZmVlZF9pZAAAAAAEAAAAQkJpbGxldGVyYSBkZSBsYSB0ZXNvcmVyw61hIGRlIEFncm9CYW5rIChyZWNpYmUgZWwgc3ByZWFkIGRpcmVjdG8pLgAAAAAACHRyZWFzdXJ5AAAAEwAAABVDb250cmF0byBTQUMgZGUgVVNEQy4AAAAAAAAEdXNkYwAAABM=",
        "AAAAAgAAAAAAAAAAAAAACkxvYW5TdGF0dXMAAAAAAAMAAAAAAAAAAAAAAAZBY3RpdmUAAAAAAAAAAAAAAAAABlJlcGFpZAAAAAAAAAAAAFBFbiBsaXF1aWRhY2nDs246IGhhYmlsaXRhIGxhIGVqZWN1Y2nDs24gZsOtc2ljYSBkZWwgZVdhcnJhbnQgW0RlY3JldG8gNjQwLzIwMjRdLgAAAAlEZWZhdWx0ZWQAAAA=",
        "AAAABQAAAAAAAAAAAAAACkxvYW5SZXBhaWQAAAAAAAEAAAALbG9hbl9yZXBhaWQAAAAAAwAAAAAAAAAHbG9hbl9pZAAAAAAGAAAAAQAAAAAAAAAHdG9fcG9vbAAAAAALAAAAAAAAAAAAAAALdG9fdHJlYXN1cnkAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADFlpZWxkQ2xhaW1lZAAAAAEAAAANeWllbGRfY2xhaW1lZAAAAAAAAAIAAAAAAAAACGludmVzdG9yAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADUxvYW5EZWZhdWx0ZWQAAAAAAAABAAAADmxvYW5fZGVmYXVsdGVkAAAAAAADAAAAAAAAAAdsb2FuX2lkAAAAAAYAAAABAAAAAAAAAAdleHBpcmVkAAAAAAEAAAAAAAAAAAAAABBjb2xsYXRlcmFsX3ZhbHVlAAAACwAAAAAAAAAC",
        "AAAAAQAAAEhSZWdpc3RybyBwb3IgcHLDqXN0YW1vOiByZXNwYWxkbyAxOjEgY29uIGVsIGVXYXJyYW50IFtEZWNyZXRvIDY0MC8yMDI0XS4AAAAAAAAADkxvYW5Bc3NpZ25tZW50AAAAAAAJAAAATVRvbmVsYWRhcyBkZSBzb2phIHF1ZSByZXNwYWxkYW4gZWwgZVdhcnJhbnQgKG5lY2VzYXJpbyBwYXJhIHZhbHVhciBlbCByYXRpbykuAAAAAAAAEWNvbGxhdGVyYWxfdG9ubmVzAAAAAAAACwAAADtIYXNoIFNIQS0yNTYgZGVsIGVXYXJyYW50IGbDrXNpY28vbGVnYWwgW0RlY3JldG8gNjQwLzIwMjRdLgAAAAAOZV93YXJyYW50X2hhc2gAAAAAA+4AAAAgAAAAKExlZGdlciBkZSB2ZW5jaW1pZW50byAoZmluIGRlIGNhbXBhw7FhKS4AAAANZXhwaXJ5X2xlZGdlcgAAAAAAAAQAAAAZQmlsbGV0ZXJhIGRlbCBhZ3JpY3VsdG9yLgAAAAAAAA5mYXJtZXJfYWRkcmVzcwAAAAAAEwAAACBUYXNhIGFjdGl2YSBlbiBicHMgKDE4MDAgPSAxOCUpLgAAABFpbnRlcmVzdF9yYXRlX2JwcwAAAAAAAAQAAAAtVGFzYSBwYXNpdmEgYSBpbnZlcnNvcmVzIGVuIGJwcyAoMTIwMCA9IDEyJSkuAAAAAAAAEmludmVzdG9yX3lpZWxkX2JwcwAAAAAABAAAACpQcmluY2lwYWwgcHJlc3RhZG8sIGVuIFVTREMgKDcgZGVjaW1hbGVzKS4AAAAAAA1wcmluY2lwYWxfdXNkAAAAAAAACwAAACxMZWRnZXIgZGUgb3JpZ2luYWNpw7NuIChpbmljaW8gZGVsIGRldmVuZ28pLgAAAAxzdGFydF9sZWRnZXIAAAAEAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAKTG9hblN0YXR1cwAA",
        "AAAABQAAAAAAAAAAAAAADkxvYW5PcmlnaW5hdGVkAAAAAAABAAAAD2xvYW5fb3JpZ2luYXRlZAAAAAAEAAAAAAAAAAdsb2FuX2lkAAAAAAYAAAABAAAAAAAAAAZmYXJtZXIAAAAAABMAAAAAAAAAAAAAAAlwcmluY2lwYWwAAAAAAAALAAAAAAAAAAAAAAAOZV93YXJyYW50X2hhc2gAAAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAAAQAAAAAAAAAAAAAAEEludmVzdG9yUG9zaXRpb24AAAADAAAAK1JlbmRpbWllbnRvIHlhIGRldmVuZ2FkbyB5IGHDum4gbm8gY29icmFkby4AAAAADXBlbmRpbmdfeWllbGQAAAAAAAALAAAAQ3NoYXJlcyAqIGFjY195aWVsZF9wZXJfc2hhcmUgLyBBQ0NfUFJFQ0lTSU9OIGFsIMO6bHRpbW8gbW92aW1pZW50by4AAAAAC3Jld2FyZF9kZWJ0AAAAAAsAAAAuUGFydGljaXBhY2nDs24gKDEgVVNEQyBkZXBvc2l0YWRvID0gMSB1bmlkYWQpLgAAAAAABnNoYXJlcwAAAAAACw==",
        "AAAABQAAAAAAAAAAAAAAEkxpcXVpZGl0eURlcG9zaXRlZAAAAAAAAQAAABNsaXF1aWRpdHlfZGVwb3NpdGVkAAAAAAMAAAAAAAAACGludmVzdG9yAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAADXBlbmRpbmdfeWllbGQAAAAAAAALAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAEkxpcXVpZGl0eVdpdGhkcmF3bgAAAAAAAQAAABNsaXF1aWRpdHlfd2l0aGRyYXduAAAAAAIAAAAAAAAACGludmVzdG9yAAAAEwAAAAEAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAC",
        "AAAAAAAAAAAAAAAIZ2V0X2xvYW4AAAABAAAAAAAAAAdsb2FuX2lkAAAAAAYAAAABAAAD6QAAB9AAAAAOTG9hbkFzc2lnbm1lbnQAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPpAAAH0AAAAAZDb25maWcAAAAAAAM=",
        "AAAAAAAAAJBDb25maWd1cmEgZWwgcHJvdG9jb2xvLiBTZSBwdWVkZSBlamVjdXRhciBVTkEgc29sYSB2ZXo7IGVqZWN1dGFybGEgZW4gbGEKbWlzbWEgc2VjdWVuY2lhIGRlIGNvbWFuZG9zIHF1ZSBlbCBkZXBsb3kgeSB2ZXJpZmljYXIgY29uIGBnZXRfY29uZmlnYC4AAAAKaW5pdGlhbGl6ZQAAAAAABQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAR1c2RjAAAAEwAAAAAAAAAIdHJlYXN1cnkAAAATAAAAAAAAAA1weXRoX3ZlcmlmaWVyAAAAAAAAEwAAAAAAAAALc295X2ZlZWRfaWQAAAAABAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAC8odG90YWxfc2hhcmVzLCB0b3RhbF9sZW50LCBhY2NfeWllbGRfcGVyX3NoYXJlKQAAAAAKcG9vbF9zdGF0cwAAAAAAAAAAAAEAAAPtAAAAAwAAAAsAAAALAAAACw==",
        "AAAAAAAAAQdFbiBVTkEgdHJhbnNhY2Npw7NuLCBkZXNkZSBsYSBiaWxsZXRlcmEgZGVsIGFncmljdWx0b3I6CihhKSBjYXBpdGFsICsgaW50ZXLDqXMgcGFzaXZvICgxMiUgVE5BKSDihpIgcG9vbCBkZSBpbnZlcnNvcmVzIChlc3RlIGNvbnRyYXRvKQooYikgc3ByZWFkICg2JSBUTkEgPSBhY3RpdmEgLSBwYXNpdmEpICDihpIgYmlsbGV0ZXJhIGRlIHRlc29yZXLDrWEKU2kgY3VhbHF1aWVyYSBkZSBsYXMgZG9zIHRyYW5zZmVyZW5jaWFzIGZhbGxhLCByZXZpZXJ0ZSB0b2RvLgAAAAAKcmVwYXlfbG9hbgAAAAAAAgAAAAAAAAAGZmFybWVyAAAAAAATAAAAAAAAAAdsb2FuX2lkAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAE1Db2JyYSBlbCByZW5kaW1pZW50byBkZXZlbmdhZG8gKHZpZW5lIGV4Y2x1c2l2YW1lbnRlIGRlIGludGVyZXNlcyByZXBhZ2Fkb3MpLgAAAAAAAAtjbGFpbV95aWVsZAAAAAABAAAAAAAAAAhpbnZlc3RvcgAAABMAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAAAAAAAMZ2V0X2ludmVzdG9yAAAAAQAAAAAAAAAIaW52ZXN0b3IAAAATAAAAAQAAB9AAAAAQSW52ZXN0b3JQb3NpdGlvbg==",
        "AAAAAAAAAQtPcmlnaW5hIHVuIHByw6lzdGFtby4gUmVxdWllcmUgZmlybWEgZGVsIGFncmljdWx0b3IgeSBkZWwgYWRtaW4gKGVsIGFkbWluCmF0ZXN0aWd1YSBzY29yZSBkZSBDYXJ0YXMgZGUgUG9ydGUgeSB2YWxpZGV6IGRlbCBlV2FycmFudCBmdWVyYSBkZSBsYSBjYWRlbmEpLgpCbG9xdWVhIGVsIGhhc2ggZGVsIGVXYXJyYW50ICh1biBoYXNoID0gdW4gcHLDqXN0YW1vKSB5IHZlcmlmaWNhIG9uLWNoYWluIGVsCnJhdGlvIGRlbCAxMzAlIGNvbiBlbCBwcmVjaW8gZGUgUHl0aC4AAAAADHJlcXVlc3RfbG9hbgAAAAYAAAAAAAAABmZhcm1lcgAAAAAAEwAAAAAAAAAJcHJpbmNpcGFsAAAAAAAACwAAAAAAAAARY29sbGF0ZXJhbF90b25uZXMAAAAAAAALAAAAAAAAAA1leHBpcnlfbGVkZ2VyAAAAAAAABAAAAAAAAAAOZV93YXJyYW50X2hhc2gAAAAAA+4AAAAgAAAAAAAAAAxwcmljZV91cGRhdGUAAAAOAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAAAJNSZWNpYmUgVVNEQyBkZWwgaW52ZXJzb3IgdsOtYSBTQUMgKGB0b2tlbjo6Q2xpZW50YCksIGVtaXRlIHNoYXJlcyAxOjEgeQpyZWdpc3RyYSBzdSByZW5kaW1pZW50byBhY3VtdWxhZG8uIERldnVlbHZlIGVsIHJlbmRpbWllbnRvIGHDum4gbm8gY29icmFkby4AAAAAEWRlcG9zaXRfbGlxdWlkaXR5AAAAAAAAAgAAAAAAAAAIaW52ZXN0b3IAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAIBSZXRpcmEgY2FwaXRhbCBubyBwcmVzdGFkbzogYGFtb3VudCA8PSBzaGFyZXMgcHJvcGlhc2AgeQpgYW1vdW50IDw9IHRvdGFsX3NoYXJlcyAtIHRvdGFsX2xlbnRgIChsaXF1aWRleiBkaXNwb25pYmxlIGVuIGVsIHBvb2wpLgAAABJ3aXRoZHJhd19saXF1aWRpdHkAAAAAAAIAAAAAAAAACGludmVzdG9yAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAZtQZXJtaXNpb25sZXNzIChjdWFscXVpZXIga2VlcGVyKS4gTWFyY2EgZWwgY3LDqWRpdG8gY29tbyBgRGVmYXVsdGVkYCBzaToKKiB2ZW5jacOzIGBleHBpcnlfbGVkZ2VyYCBzaW4gcmVwYWdvIChubyByZXF1aWVyZSBvcsOhY3VsbyksIG8KKiBlbCB2YWxvciBkZWwgY29sYXRlcmFsLCBzZWfDum4gUHl0aCwgY2FlIGJham8gZWwgMTMwJSBkZWwgcHJpbmNpcGFsLgpgcHJpY2VfdXBkYXRlYCBlcyBlbCBwYXlsb2FkIGZpcm1hZG8gKG1vZGVsbyBwdWxsKSBxdWUgc2UgdmVyaWZpY2Egb24tY2hhaW4KbWVkaWFudGUgY3Jvc3MtY29udHJhY3QgY2FsbCBhbCB2ZXJpZmljYWRvciBkZSBQeXRoLgpTb2xvIGNhbWJpYSBlbCBlc3RhZG86IGxhIGVqZWN1Y2nDs24gZsOtc2ljYSBkZWwgZVdhcnJhbnQgb2N1cnJlIG9mZi1jaGFpbi4AAAAAFGxpcXVpZGF0ZV9jb2xsYXRlcmFsAAAAAgAAAAAAAAAHbG9hbl9pZAAAAAAGAAAAAAAAAAxwcmljZV91cGRhdGUAAAAOAAAAAQAAA+kAAAfQAAAACkxvYW5TdGF0dXMAAAAAAAM=" ]),
      options
    )
  }
  public readonly fromJSON = {
    get_loan: this.txFromJSON<Result<LoanAssignment>>,
        get_config: this.txFromJSON<Result<Config>>,
        initialize: this.txFromJSON<Result<void>>,
        pool_stats: this.txFromJSON<readonly [i128, i128, i128]>,
        repay_loan: this.txFromJSON<Result<void>>,
        claim_yield: this.txFromJSON<Result<i128>>,
        get_investor: this.txFromJSON<InvestorPosition>,
        request_loan: this.txFromJSON<Result<u64>>,
        deposit_liquidity: this.txFromJSON<Result<i128>>,
        withdraw_liquidity: this.txFromJSON<Result<void>>,
        liquidate_collateral: this.txFromJSON<Result<LoanStatus>>
  }
}