//! AgroBank Protocol — Stellar Soroban (soroban-sdk v28)
//!
//! Protocolo de préstamos colaterales 1 a 1: inversores depositan USDC (SAC),
//! agricultores piden crédito contra un eWarrant de soja [Decreto 640/2024].
//!
//! Economía (TNA, parametrizable en las constantes de abajo):
//!   * Tasa activa (agricultor):  1800 bps (18%)
//!   * Tasa pasiva (inversores):  1200 bps (12%)
//!   * Spread de tesorería:        600 bps ( 6%)  = activa - pasiva
//!   * Sobre-colateralización mínima: 130%
//!
//! Interés: se devenga sobre el plazo pactado (`expiry_ledger - start_ledger`),
//! prorrateado a un año de `LEDGERS_PER_YEAR` ledgers. Para un plazo de 365 días
//! el interés es exactamente 18% / 12% / 6% del principal.
//!
//! API pública:
//!   initialize, deposit_liquidity, withdraw_liquidity, claim_yield,
//!   request_loan, repay_loan (Split Atómico), liquidate_collateral (Pyth),
//!   y vistas: get_config, get_loan, get_investor, pool_stats.

#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Bytes, BytesN, Env,
};

// ───────────────────────────── Constantes ─────────────────────────────

/// Denominador de puntos básicos.
pub const BPS_DENOM: i128 = 10_000;
/// Tasa activa que paga el agricultor: 18% TNA.
pub const ACTIVE_RATE_BPS: u32 = 1_800;
/// Tasa pasiva que cobran los inversores: 12% TNA.
pub const PASSIVE_RATE_BPS: u32 = 1_200;
/// Spread de tesorería (derivado): 6% TNA.
pub const TREASURY_SPREAD_BPS: u32 = ACTIVE_RATE_BPS - PASSIVE_RATE_BPS;
/// Ratio mínimo de sobre-colateralización: 130%.
pub const MIN_COLLATERAL_RATIO_BPS: i128 = 13_000;
/// Precisión del acumulador de rendimiento por unidad de participación.
pub const ACC_PRECISION: i128 = 1_000_000_000_000;
/// USDC en Stellar usa 7 decimales.
pub const USDC_DECIMALS: i32 = 7;
/// Antigüedad máxima aceptada del precio de Pyth (segundos).
pub const MAX_PRICE_AGE_SECS: u64 = 60;
/// Ledgers por día (~5 s por ledger).
pub const DAY_IN_LEDGERS: u32 = 17_280;
/// Ledgers por año de 365 días: base del prorrateo de intereses.
pub const LEDGERS_PER_YEAR: i128 = 365 * DAY_IN_LEDGERS as i128;

const TTL_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 60 * DAY_IN_LEDGERS;

// ───────────────────────────── Errores ─────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    InvalidAmount = 2,
    InvalidRate = 3,
    InvalidExpiry = 4,
    LoanNotFound = 5,
    LoanNotActive = 6,
    NotBorrower = 7,
    WarrantAlreadyPledged = 8,
    InsufficientLiquidity = 9,
    Undercollateralized = 10,
    NotLiquidatable = 11,
    MathOverflow = 12,
    NoShares = 13,
    StalePrice = 14,
    InvalidPrice = 15,
    WrongFeed = 16,
    NothingToClaim = 17,
    AlreadyInitialized = 18,
    InsufficientShares = 19,
}

// ───────────────────────────── Tipos de datos ─────────────────────────────

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum LoanStatus {
    Active,
    Repaid,
    /// En liquidación: habilita la ejecución física del eWarrant [Decreto 640/2024].
    Defaulted,
}

/// Registro por préstamo: respaldo 1:1 con el eWarrant [Decreto 640/2024].
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoanAssignment {
    /// Billetera del agricultor.
    pub farmer_address: Address,
    /// Principal prestado, en USDC (7 decimales).
    pub principal_usd: i128,
    /// Ledger de originación (inicio del devengo).
    pub start_ledger: u32,
    /// Ledger de vencimiento (fin de campaña).
    pub expiry_ledger: u32,
    /// Hash SHA-256 del eWarrant físico/legal [Decreto 640/2024].
    pub e_warrant_hash: BytesN<32>,
    /// Toneladas de soja que respaldan el eWarrant (necesario para valuar el ratio).
    pub collateral_tonnes: i128,
    /// Tasa activa en bps (1800 = 18%).
    pub interest_rate_bps: u32,
    /// Tasa pasiva a inversores en bps (1200 = 12%).
    pub investor_yield_bps: u32,
    pub status: LoanStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// Contrato SAC de USDC.
    pub usdc: Address,
    /// Billetera de la tesorería de AgroBank (recibe el spread directo).
    pub treasury: Address,
    /// Contrato verificador de Pyth Pro.
    pub pyth_verifier: Address,
    /// Feed ID de Pyth para la soja.
    pub soy_feed_id: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvestorPosition {
    /// Participación (1 USDC depositado = 1 unidad).
    pub shares: i128,
    /// shares * acc_yield_per_share / ACC_PRECISION al último movimiento.
    pub reward_debt: i128,
    /// Rendimiento ya devengado y aún no cobrado.
    pub pending_yield: i128,
}

#[contracttype]
pub enum DataKey {
    Config,
    TotalShares,
    TotalLent,
    AccYieldPerShare,
    NextLoanId,
    Loan(u64),
    Investor(Address),
    /// eWarrant hash → loan_id (impide el doble pignoramiento).
    Warrant(BytesN<32>),
}

// ───────────────────────────── Interfaz del oráculo ─────────────────────────────

/// Precio ya verificado criptográficamente por el contrato verificador de Pyth.
///
/// SUPUESTO DE INTERFAZ: la firma exacta del verificador de Pyth Pro en Stellar
/// no pudo confirmarse contra documentación oficial. Esta capa es un ADAPTADOR:
/// si la firma real difiere, solo cambian `PythVerifierInterface` y
/// `read_soy_price`; el resto del contrato no se toca.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedPrice {
    pub feed_id: u32,
    pub price: i64,
    pub exponent: i32,
    /// Timestamp de publicación en microsegundos.
    pub publish_time_us: u64,
}

#[contractclient(name = "PythVerifierClient")]
pub trait PythVerifierInterface {
    /// Verifica la firma del update y devuelve el precio decodificado.
    fn verify_update(env: Env, update: Bytes) -> VerifiedPrice;
}

// ───────────────────────────── Eventos ─────────────────────────────

#[contractevent]
pub struct LiquidityDeposited {
    #[topic]
    pub investor: Address,
    pub amount: i128,
    pub pending_yield: i128,
}

#[contractevent]
pub struct LiquidityWithdrawn {
    #[topic]
    pub investor: Address,
    pub amount: i128,
}

#[contractevent]
pub struct LoanOriginated {
    #[topic]
    pub loan_id: u64,
    pub farmer: Address,
    pub principal: i128,
    pub e_warrant_hash: BytesN<32>,
}

#[contractevent]
pub struct LoanRepaid {
    #[topic]
    pub loan_id: u64,
    pub to_pool: i128,
    pub to_treasury: i128,
}

#[contractevent]
pub struct LoanDefaulted {
    #[topic]
    pub loan_id: u64,
    pub expired: bool,
    pub collateral_value: i128,
}

#[contractevent]
pub struct YieldClaimed {
    #[topic]
    pub investor: Address,
    pub amount: i128,
}

// ───────────────────────────── Funciones puras ─────────────────────────────

fn pow10(n: u32) -> Result<i128, Error> {
    10i128.checked_pow(n).ok_or(Error::MathOverflow)
}

/// Valor del colateral en unidades de USDC (7 decimales).
/// `price` está en USD por tonelada con `exponent` de Pyth (típicamente negativo).
pub fn collateral_value_usdc(tonnes: i128, price: i128, exponent: i32) -> Result<i128, Error> {
    let gross = tonnes.checked_mul(price).ok_or(Error::MathOverflow)?;
    let shift = exponent.saturating_add(USDC_DECIMALS);
    if !(-30..=30).contains(&shift) {
        return Err(Error::InvalidPrice);
    }
    let scale = pow10(shift.unsigned_abs())?;
    if shift >= 0 {
        gross.checked_mul(scale).ok_or(Error::MathOverflow)
    } else {
        Ok(gross / scale)
    }
}

/// ¿El colateral cubre al menos el 130% del principal?
pub fn meets_collateral_ratio(collateral_value: i128, principal: i128) -> Result<bool, Error> {
    let lhs = collateral_value
        .checked_mul(BPS_DENOM)
        .ok_or(Error::MathOverflow)?;
    let rhs = principal
        .checked_mul(MIN_COLLATERAL_RATIO_BPS)
        .ok_or(Error::MathOverflow)?;
    Ok(lhs >= rhs)
}

/// Interés de `principal` a `rate_bps` TNA durante `term_ledgers`.
fn interest_for(principal: i128, rate_bps: u32, term_ledgers: u32) -> Result<i128, Error> {
    let num = principal
        .checked_mul(rate_bps as i128)
        .ok_or(Error::MathOverflow)?
        .checked_mul(term_ledgers as i128)
        .ok_or(Error::MathOverflow)?;
    let den = BPS_DENOM
        .checked_mul(LEDGERS_PER_YEAR)
        .ok_or(Error::MathOverflow)?;
    Ok(num / den)
}

/// Split atómico: devuelve (interés_total, interés_inversores, spread_tesorería).
/// El spread se calcula por resta para que la suma sea exacta (sin polvo perdido).
pub fn split_interest(
    principal: i128,
    rate_bps: u32,
    yield_bps: u32,
    term_ledgers: u32,
) -> Result<(i128, i128, i128), Error> {
    if rate_bps < yield_bps {
        return Err(Error::InvalidRate);
    }
    let total = interest_for(principal, rate_bps, term_ledgers)?;
    let investors = interest_for(principal, yield_bps, term_ledgers)?;
    Ok((total, investors, total - investors))
}

// ───────────────────────────── Helpers de storage ─────────────────────────────

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn load_config(env: &Env) -> Result<Config, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(Error::NotInitialized)
}

fn get_i128(env: &Env, key: &DataKey) -> i128 {
    env.storage().instance().get(key).unwrap_or(0)
}

fn set_i128(env: &Env, key: &DataKey, v: i128) {
    env.storage().instance().set(key, &v);
}

fn load_loan(env: &Env, loan_id: u64) -> Result<LoanAssignment, Error> {
    let key = DataKey::Loan(loan_id);
    let loan: LoanAssignment = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::LoanNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    Ok(loan)
}

fn save_loan(env: &Env, loan_id: u64, loan: &LoanAssignment) {
    let key = DataKey::Loan(loan_id);
    env.storage().persistent().set(&key, loan);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn load_investor(env: &Env, who: &Address) -> InvestorPosition {
    env.storage()
        .persistent()
        .get(&DataKey::Investor(who.clone()))
        .unwrap_or(InvestorPosition {
            shares: 0,
            reward_debt: 0,
            pending_yield: 0,
        })
}

fn save_investor(env: &Env, who: &Address, pos: &InvestorPosition) {
    let key = DataKey::Investor(who.clone());
    env.storage().persistent().set(&key, pos);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Pasa al `pending_yield` todo lo devengado desde el último movimiento.
fn settle_investor(pos: &mut InvestorPosition, acc: i128) -> Result<(), Error> {
    let gross = pos
        .shares
        .checked_mul(acc)
        .ok_or(Error::MathOverflow)?
        / ACC_PRECISION;
    let accrued = gross - pos.reward_debt;
    pos.pending_yield = pos
        .pending_yield
        .checked_add(accrued)
        .ok_or(Error::MathOverflow)?;
    pos.reward_debt = gross;
    Ok(())
}

/// Lee y valida el precio de la soja vía el verificador de Pyth.
fn read_soy_price(env: &Env, cfg: &Config, update: Bytes) -> Result<(i128, i32), Error> {
    let v = PythVerifierClient::new(env, &cfg.pyth_verifier).verify_update(&update);
    if v.feed_id != cfg.soy_feed_id {
        return Err(Error::WrongFeed);
    }
    if v.price <= 0 {
        return Err(Error::InvalidPrice);
    }
    let now_us = env
        .ledger()
        .timestamp()
        .checked_mul(1_000_000)
        .ok_or(Error::MathOverflow)?;
    let age_us = now_us.saturating_sub(v.publish_time_us);
    if age_us > MAX_PRICE_AGE_SECS * 1_000_000 {
        return Err(Error::StalePrice);
    }
    Ok((v.price as i128, v.exponent))
}

// ───────────────────────────── Contrato ─────────────────────────────

#[contract]
pub struct AgroBankProtocol;

#[contractimpl]
impl AgroBankProtocol {
    // ── 1. Configuración ───────────────────────────────────────────

    /// Configura el protocolo. Se puede ejecutar UNA sola vez; ejecutarla en la
    /// misma secuencia de comandos que el deploy y verificar con `get_config`.
    pub fn initialize(
        env: Env,
        admin: Address,
        usdc: Address,
        treasury: Address,
        pyth_verifier: Address,
        soy_feed_id: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                admin,
                usdc,
                treasury,
                pyth_verifier,
                soy_feed_id,
            },
        );
        set_i128(&env, &DataKey::TotalShares, 0);
        set_i128(&env, &DataKey::TotalLent, 0);
        set_i128(&env, &DataKey::AccYieldPerShare, 0);
        env.storage().instance().set(&DataKey::NextLoanId, &0u64);
        bump_instance(&env);
        Ok(())
    }

    // ── 2. Inversores ──────────────────────────────────────────────

    /// Recibe USDC del inversor vía SAC (`token::Client`), emite shares 1:1 y
    /// registra su rendimiento acumulado. Devuelve el rendimiento aún no cobrado.
    pub fn deposit_liquidity(env: Env, investor: Address, amount: i128) -> Result<i128, Error> {
        investor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        bump_instance(&env);
        let cfg = load_config(&env)?;

        token::Client::new(&env, &cfg.usdc).transfer(
            &investor,
            &env.current_contract_address(),
            &amount,
        );

        let acc = get_i128(&env, &DataKey::AccYieldPerShare);
        let mut pos = load_investor(&env, &investor);
        settle_investor(&mut pos, acc)?; // cierra el devengo con las shares viejas
        pos.shares = pos.shares.checked_add(amount).ok_or(Error::MathOverflow)?;
        pos.reward_debt = pos
            .shares
            .checked_mul(acc)
            .ok_or(Error::MathOverflow)?
            / ACC_PRECISION;
        save_investor(&env, &investor, &pos);

        let total = get_i128(&env, &DataKey::TotalShares)
            .checked_add(amount)
            .ok_or(Error::MathOverflow)?;
        set_i128(&env, &DataKey::TotalShares, total);

        LiquidityDeposited {
            investor,
            amount,
            pending_yield: pos.pending_yield,
        }
        .publish(&env);
        Ok(pos.pending_yield)
    }

    /// Retira capital no prestado: `amount <= shares propias` y
    /// `amount <= total_shares - total_lent` (liquidez disponible en el pool).
    pub fn withdraw_liquidity(env: Env, investor: Address, amount: i128) -> Result<(), Error> {
        investor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        bump_instance(&env);
        let cfg = load_config(&env)?;

        let acc = get_i128(&env, &DataKey::AccYieldPerShare);
        let mut pos = load_investor(&env, &investor);
        if pos.shares < amount {
            return Err(Error::InsufficientShares);
        }
        let total = get_i128(&env, &DataKey::TotalShares);
        let lent = get_i128(&env, &DataKey::TotalLent);
        if amount > total - lent {
            return Err(Error::InsufficientLiquidity);
        }

        settle_investor(&mut pos, acc)?;
        pos.shares -= amount;
        pos.reward_debt = pos
            .shares
            .checked_mul(acc)
            .ok_or(Error::MathOverflow)?
            / ACC_PRECISION;
        save_investor(&env, &investor, &pos);
        set_i128(&env, &DataKey::TotalShares, total - amount);

        token::Client::new(&env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &investor,
            &amount,
        );
        LiquidityWithdrawn { investor, amount }.publish(&env);
        Ok(())
    }

    /// Cobra el rendimiento devengado (viene exclusivamente de intereses repagados).
    pub fn claim_yield(env: Env, investor: Address) -> Result<i128, Error> {
        investor.require_auth();
        bump_instance(&env);
        let cfg = load_config(&env)?;
        let acc = get_i128(&env, &DataKey::AccYieldPerShare);
        let mut pos = load_investor(&env, &investor);
        settle_investor(&mut pos, acc)?;
        let amount = pos.pending_yield;
        if amount <= 0 {
            return Err(Error::NothingToClaim);
        }
        pos.pending_yield = 0;
        save_investor(&env, &investor, &pos);
        token::Client::new(&env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &investor,
            &amount,
        );
        YieldClaimed { investor, amount }.publish(&env);
        Ok(amount)
    }

    // ── 3. Originación ─────────────────────────────────────────────

    /// Origina un préstamo. Requiere firma del agricultor y del admin (el admin
    /// atestigua score de Cartas de Porte y validez del eWarrant fuera de la cadena).
    /// Bloquea el hash del eWarrant (un hash = un préstamo) y verifica on-chain el
    /// ratio del 130% con el precio de Pyth.
    pub fn request_loan(
        env: Env,
        farmer: Address,
        principal: i128,
        collateral_tonnes: i128,
        expiry_ledger: u32,
        e_warrant_hash: BytesN<32>,
        price_update: Bytes,
    ) -> Result<u64, Error> {
        let cfg = load_config(&env)?;
        cfg.admin.require_auth();
        farmer.require_auth();
        if principal <= 0 || collateral_tonnes <= 0 {
            return Err(Error::InvalidAmount);
        }
        let start_ledger = env.ledger().sequence();
        if expiry_ledger <= start_ledger {
            return Err(Error::InvalidExpiry);
        }
        bump_instance(&env);

        let warrant_key = DataKey::Warrant(e_warrant_hash.clone());
        if env.storage().persistent().has(&warrant_key) {
            return Err(Error::WarrantAlreadyPledged);
        }

        let lent = get_i128(&env, &DataKey::TotalLent);
        let shares = get_i128(&env, &DataKey::TotalShares);
        let new_lent = lent.checked_add(principal).ok_or(Error::MathOverflow)?;
        if new_lent > shares {
            return Err(Error::InsufficientLiquidity);
        }

        let (price, exp) = read_soy_price(&env, &cfg, price_update)?;
        let value = collateral_value_usdc(collateral_tonnes, price, exp)?;
        if !meets_collateral_ratio(value, principal)? {
            return Err(Error::Undercollateralized);
        }

        let loan_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextLoanId)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::NextLoanId, &(loan_id + 1));

        let loan = LoanAssignment {
            farmer_address: farmer.clone(),
            principal_usd: principal,
            start_ledger,
            expiry_ledger,
            e_warrant_hash: e_warrant_hash.clone(),
            collateral_tonnes,
            interest_rate_bps: ACTIVE_RATE_BPS,
            investor_yield_bps: PASSIVE_RATE_BPS,
            status: LoanStatus::Active,
        };
        save_loan(&env, loan_id, &loan);
        env.storage().persistent().set(&warrant_key, &loan_id);
        env.storage()
            .persistent()
            .extend_ttl(&warrant_key, TTL_THRESHOLD, TTL_EXTEND_TO);
        set_i128(&env, &DataKey::TotalLent, new_lent);

        token::Client::new(&env, &cfg.usdc).transfer(
            &env.current_contract_address(),
            &farmer,
            &principal,
        );

        LoanOriginated {
            loan_id,
            farmer,
            principal,
            e_warrant_hash,
        }
        .publish(&env);
        Ok(loan_id)
    }

    // ── 4. Repago con Split Atómico ────────────────────────────────

    /// En UNA transacción, desde la billetera del agricultor:
    ///   (a) capital + interés pasivo (12% TNA) → pool de inversores (este contrato)
    ///   (b) spread (6% TNA = activa - pasiva)  → billetera de tesorería
    /// Si cualquiera de las dos transferencias falla, revierte todo.
    pub fn repay_loan(env: Env, farmer: Address, loan_id: u64) -> Result<(), Error> {
        farmer.require_auth();
        bump_instance(&env);
        let cfg = load_config(&env)?;
        let mut loan = load_loan(&env, loan_id)?;
        if loan.farmer_address != farmer {
            return Err(Error::NotBorrower);
        }
        if loan.status != LoanStatus::Active {
            return Err(Error::LoanNotActive);
        }

        let term = loan.expiry_ledger.saturating_sub(loan.start_ledger);
        let (_total, investor_interest, spread) = split_interest(
            loan.principal_usd,
            loan.interest_rate_bps,
            loan.investor_yield_bps,
            term,
        )?;
        let to_pool = loan
            .principal_usd
            .checked_add(investor_interest)
            .ok_or(Error::MathOverflow)?;

        // Estado primero (checks-effects-interactions).
        let shares = get_i128(&env, &DataKey::TotalShares);
        if shares <= 0 {
            return Err(Error::NoShares);
        }
        let acc = get_i128(&env, &DataKey::AccYieldPerShare)
            .checked_add(
                investor_interest
                    .checked_mul(ACC_PRECISION)
                    .ok_or(Error::MathOverflow)?
                    / shares,
            )
            .ok_or(Error::MathOverflow)?;
        set_i128(&env, &DataKey::AccYieldPerShare, acc);
        set_i128(
            &env,
            &DataKey::TotalLent,
            get_i128(&env, &DataKey::TotalLent) - loan.principal_usd,
        );
        loan.status = LoanStatus::Repaid;
        save_loan(&env, loan_id, &loan);
        env.storage()
            .persistent()
            .remove(&DataKey::Warrant(loan.e_warrant_hash.clone()));

        // Split atómico: ambas transferencias salen de la billetera del agricultor.
        let usdc = token::Client::new(&env, &cfg.usdc);
        usdc.transfer(&farmer, &env.current_contract_address(), &to_pool);
        if spread > 0 {
            usdc.transfer(&farmer, &cfg.treasury, &spread);
        }

        LoanRepaid {
            loan_id,
            to_pool,
            to_treasury: spread,
        }
        .publish(&env);
        Ok(())
    }

    // ── 5. Liquidación con Pyth ────────────────────────────────────

    /// Permisionless (cualquier keeper). Marca el crédito como `Defaulted` si:
    ///   * venció `expiry_ledger` sin repago (no requiere oráculo), o
    ///   * el valor del colateral, según Pyth, cae bajo el 130% del principal.
    /// `price_update` es el payload firmado (modelo pull) que se verifica on-chain
    /// mediante cross-contract call al verificador de Pyth.
    /// Solo cambia el estado: la ejecución física del eWarrant ocurre off-chain.
    pub fn liquidate_collateral(
        env: Env,
        loan_id: u64,
        price_update: Bytes,
    ) -> Result<LoanStatus, Error> {
        bump_instance(&env);
        let cfg = load_config(&env)?;
        let mut loan = load_loan(&env, loan_id)?;
        if loan.status != LoanStatus::Active {
            return Err(Error::LoanNotActive);
        }

        let expired = env.ledger().sequence() > loan.expiry_ledger;
        let mut value: i128 = 0;
        let mut under = false;
        if !expired {
            let (price, exp) = read_soy_price(&env, &cfg, price_update)?;
            value = collateral_value_usdc(loan.collateral_tonnes, price, exp)?;
            under = !meets_collateral_ratio(value, loan.principal_usd)?;
        }
        if !expired && !under {
            return Err(Error::NotLiquidatable);
        }

        loan.status = LoanStatus::Defaulted;
        save_loan(&env, loan_id, &loan);
        LoanDefaulted {
            loan_id,
            expired,
            collateral_value: value,
        }
        .publish(&env);
        Ok(LoanStatus::Defaulted)
    }

    // ── Vistas ─────────────────────────────────────────────────────

    pub fn get_config(env: Env) -> Result<Config, Error> {
        load_config(&env)
    }

    pub fn get_loan(env: Env, loan_id: u64) -> Result<LoanAssignment, Error> {
        load_loan(&env, loan_id)
    }

    pub fn get_investor(env: Env, investor: Address) -> InvestorPosition {
        load_investor(&env, &investor)
    }

    /// (total_shares, total_lent, acc_yield_per_share)
    pub fn pool_stats(env: Env) -> (i128, i128, i128) {
        (
            get_i128(&env, &DataKey::TotalShares),
            get_i128(&env, &DataKey::TotalLent),
            get_i128(&env, &DataKey::AccYieldPerShare),
        )
    }
}

// ───────────────────────────── Tests ─────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token::{StellarAssetClient, TokenClient},
        Env,
    };

    const USDC: i128 = 10_000_000; // 1 USDC en unidades de 7 decimales
    const YEAR: u32 = 6_307_200; // LEDGERS_PER_YEAR

    // Pyth simulado: precio configurable, publicado "ahora".
    #[contract]
    pub struct MockPyth;

    #[contractimpl]
    impl MockPyth {
        pub fn set_price(env: Env, price: i64) {
            env.storage().instance().set(&1u32, &price);
        }
        pub fn verify_update(env: Env, _update: Bytes) -> VerifiedPrice {
            VerifiedPrice {
                feed_id: 7,
                price: env.storage().instance().get(&1u32).unwrap(),
                exponent: -8,
                publish_time_us: env.ledger().timestamp() * 1_000_000,
            }
        }
    }

    struct Fx<'a> {
        env: Env,
        bank: AgroBankProtocolClient<'a>,
        usdc: TokenClient<'a>,
        pyth: MockPythClient<'a>,
        investor: Address,
        farmer: Address,
        treasury: Address,
    }

    fn setup<'a>() -> Fx<'a> {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| {
            l.sequence_number = 1_000;
            l.timestamp = 1_700_000_000;
        });
        let admin = Address::generate(&env);
        let investor = Address::generate(&env);
        let farmer = Address::generate(&env);
        let treasury = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let usdc_addr = sac.address();
        let mint = StellarAssetClient::new(&env, &usdc_addr);
        mint.mint(&investor, &(100_000 * USDC));
        mint.mint(&farmer, &(100_000 * USDC)); // para pagar intereses
        let pyth_id = env.register(MockPyth, ());
        let pyth = MockPythClient::new(&env, &pyth_id);
        pyth.set_price(&40_000_000_000); // USD 400/t
        let bank_id = env.register(AgroBankProtocol, ());
        let bank = AgroBankProtocolClient::new(&env, &bank_id);
        bank.initialize(&admin, &usdc_addr, &treasury, &pyth_id, &7);
        Fx {
            usdc: TokenClient::new(&env, &usdc_addr),
            env,
            bank,
            pyth,
            investor,
            farmer,
            treasury,
        }
    }

    fn hash(env: &Env, b: u8) -> BytesN<32> {
        BytesN::from_array(env, &[b; 32])
    }

    #[test]
    fn split_matches_18_12_6_for_one_year() {
        let p = 10_000 * USDC;
        let (total, inv, spread) = split_interest(p, 1800, 1200, YEAR).unwrap();
        assert_eq!(total, p * 18 / 100);
        assert_eq!(inv, p * 12 / 100);
        assert_eq!(spread, p * 6 / 100);
        assert_eq!(inv + spread, total);
        assert_eq!(TREASURY_SPREAD_BPS, 600);
    }

    #[test]
    fn split_prorates_half_year() {
        let p = 10_000 * USDC;
        let (total, inv, spread) = split_interest(p, 1800, 1200, YEAR / 2).unwrap();
        assert_eq!(total, p * 9 / 100);
        assert_eq!(inv, p * 6 / 100);
        assert_eq!(spread, p * 3 / 100);
    }

    #[test]
    fn collateral_ratio_threshold() {
        let p = 10_000 * USDC;
        assert!(meets_collateral_ratio(p * 13 / 10, p).unwrap());
        assert!(!meets_collateral_ratio(p * 13 / 10 - 1, p).unwrap());
    }

    #[test]
    fn value_with_negative_exponent() {
        // 50 t a USD 400/t (price=40_000_000_000, exp=-8) = USD 20.000
        let v = collateral_value_usdc(50, 40_000_000_000, -8).unwrap();
        assert_eq!(v, 20_000 * USDC);
    }

    #[test]
    fn initialize_only_once() {
        let f = setup();
        let cfg = f.bank.get_config();
        let r = f
            .bank
            .try_initialize(&cfg.admin, &cfg.usdc, &cfg.treasury, &cfg.pyth_verifier, &7);
        assert_eq!(r, Err(Ok(Error::AlreadyInitialized)));
    }

    #[test]
    fn full_cycle_atomic_split_and_yield() {
        let f = setup();
        let p = 10_000 * USDC;
        f.bank.deposit_liquidity(&f.investor, &(20_000 * USDC));

        let expiry = 1_000 + YEAR;
        let id = f.bank.request_loan(
            &f.farmer, &p, &50, &expiry, &hash(&f.env, 1), &Bytes::new(&f.env),
        );
        assert_eq!(f.usdc.balance(&f.farmer), 110_000 * USDC);
        assert_eq!(f.bank.pool_stats().1, p);

        // doble pignoramiento
        let dup = f.bank.try_request_loan(
            &f.farmer, &p, &50, &expiry, &hash(&f.env, 1), &Bytes::new(&f.env),
        );
        assert_eq!(dup, Err(Ok(Error::WarrantAlreadyPledged)));

        let t0 = f.usdc.balance(&f.treasury);
        f.bank.repay_loan(&f.farmer, &id);
        // spread 6% a tesorería; capital + 12% al pool
        assert_eq!(f.usdc.balance(&f.treasury) - t0, p * 6 / 100);
        assert_eq!(f.usdc.balance(&f.farmer), 110_000 * USDC - p - p * 18 / 100);
        assert_eq!(f.bank.pool_stats().1, 0);

        // el inversor (única posición) cobra ~12% de 10.000 (polvo <= 1 unidad)
        let y = f.bank.claim_yield(&f.investor);
        assert!(y <= p * 12 / 100 && p * 12 / 100 - y <= 1);

        // retiro del capital
        f.bank.withdraw_liquidity(&f.investor, &(20_000 * USDC));
        assert_eq!(f.bank.pool_stats().0, 0);
    }

    #[test]
    fn rejects_undercollateralized_and_over_lent() {
        let f = setup();
        f.bank.deposit_liquidity(&f.investor, &(20_000 * USDC));
        // 30 t * 400 = 12.000 < 130% de 10.000
        let r = f.bank.try_request_loan(
            &f.farmer, &(10_000 * USDC), &30, &(1_000 + YEAR), &hash(&f.env, 2), &Bytes::new(&f.env),
        );
        assert_eq!(r, Err(Ok(Error::Undercollateralized)));
        let r = f.bank.try_request_loan(
            &f.farmer, &(30_000 * USDC), &500, &(1_000 + YEAR), &hash(&f.env, 3), &Bytes::new(&f.env),
        );
        assert_eq!(r, Err(Ok(Error::InsufficientLiquidity)));
    }

    #[test]
    fn liquidation_by_price_and_by_expiry() {
        let f = setup();
        f.bank.deposit_liquidity(&f.investor, &(20_000 * USDC));
        let p = 10_000 * USDC;
        let id = f.bank.request_loan(
            &f.farmer, &p, &50, &(1_000 + 100), &hash(&f.env, 4), &Bytes::new(&f.env),
        );
        // precio sano: no liquidable
        assert_eq!(
            f.bank.try_liquidate_collateral(&id, &Bytes::new(&f.env)),
            Err(Ok(Error::NotLiquidatable))
        );
        // soja cae a USD 250/t → 50 t = 12.500 < 13.000
        f.pyth.set_price(&25_000_000_000);
        assert_eq!(
            f.bank.liquidate_collateral(&id, &Bytes::new(&f.env)),
            LoanStatus::Defaulted
        );
        // por vencimiento
        f.pyth.set_price(&40_000_000_000);
        let id2 = f.bank.request_loan(
            &f.farmer, &p, &50, &(1_000 + 100), &hash(&f.env, 5), &Bytes::new(&f.env),
        );
        f.env.ledger().with_mut(|l| l.sequence_number = 1_000 + 101);
        assert_eq!(
            f.bank.liquidate_collateral(&id2, &Bytes::new(&f.env)),
            LoanStatus::Defaulted
        );
    }
}
