//! Verificador de precios para Testnet con la misma interfaz que espera AgroBank
//! (`verify_update(Bytes) -> VerifiedPrice`).
//!
//! Imita el modelo pull de Pyth Pro: el precio llega dentro de un payload firmado
//! off-chain y el contrato verifica la firma ed25519 on-chain antes de decodificarlo.
//! Mientras no exista un feed de soja en Pyth Pro sobre Stellar, la firma la hace
//! un oráculo de AgroBank (clave fijada en `initialize`).
//!
//! Formato del update (88 bytes):
//!   feed_id u32 BE | price i64 BE | exponent i32 BE | publish_time_us u64 BE | firma ed25519 (64)
//! La firma cubre los primeros 24 bytes.
#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Bytes, BytesN, Env};

pub const PAYLOAD_LEN: u32 = 24;
pub const UPDATE_LEN: u32 = PAYLOAD_LEN + 64;

/// Mismo layout que `agrobank_protocol::VerifiedPrice`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedPrice {
    pub feed_id: u32,
    pub price: i64,
    pub exponent: i32,
    pub publish_time_us: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    BadLength = 3,
}

#[contracttype]
enum Key {
    Admin,
    Signer,
}

#[contract]
pub struct PriceVerifier;

fn be<const N: usize>(b: &Bytes, from: u32) -> [u8; N] {
    let mut out = [0u8; N];
    b.slice(from..from + N as u32).copy_into_slice(&mut out);
    out
}

#[contractimpl]
impl PriceVerifier {
    pub fn initialize(env: Env, admin: Address, signer: BytesN<32>) -> Result<(), Error> {
        if env.storage().instance().has(&Key::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&Key::Admin, &admin);
        env.storage().instance().set(&Key::Signer, &signer);
        env.storage().instance().extend_ttl(100_000, 3_000_000);
        Ok(())
    }

    /// Rota la clave del oráculo.
    pub fn set_signer(env: Env, signer: BytesN<32>) -> Result<(), Error> {
        let admin: Address = env.storage().instance().get(&Key::Admin).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.storage().instance().set(&Key::Signer, &signer);
        Ok(())
    }

    pub fn signer(env: Env) -> Result<BytesN<32>, Error> {
        env.storage().instance().get(&Key::Signer).ok_or(Error::NotInitialized)
    }

    /// Verifica la firma y devuelve el precio. Una firma inválida aborta la
    /// transacción (igual que el verificador de Pyth). Las reglas de frescura las
    /// aplica AgroBank en `read_soy_price`.
    pub fn verify_update(env: Env, update: Bytes) -> VerifiedPrice {
        if update.len() != UPDATE_LEN {
            panic_with(&env, Error::BadLength);
        }
        let signer: BytesN<32> = match env.storage().instance().get(&Key::Signer) {
            Some(s) => s,
            None => panic_with(&env, Error::NotInitialized),
        };
        env.storage().instance().extend_ttl(100_000, 3_000_000);
        let payload = update.slice(0..PAYLOAD_LEN);
        let sig: BytesN<64> = update.slice(PAYLOAD_LEN..UPDATE_LEN).try_into().unwrap();
        env.crypto().ed25519_verify(&signer, &payload, &sig);
        VerifiedPrice {
            feed_id: u32::from_be_bytes(be::<4>(&update, 0)),
            price: i64::from_be_bytes(be::<8>(&update, 4)),
            exponent: i32::from_be_bytes(be::<4>(&update, 12)),
            publish_time_us: u64::from_be_bytes(be::<8>(&update, 16)),
        }
    }
}

fn panic_with(env: &Env, e: Error) -> ! {
    soroban_sdk::panic_with_error!(env, e)
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::testutils::Address as _;

    fn update(env: &Env, key: &SigningKey, feed: u32, price: i64, exp: i32, t: u64) -> Bytes {
        let mut p = std::vec::Vec::new();
        p.extend_from_slice(&feed.to_be_bytes());
        p.extend_from_slice(&price.to_be_bytes());
        p.extend_from_slice(&exp.to_be_bytes());
        p.extend_from_slice(&t.to_be_bytes());
        let sig = key.sign(&p);
        p.extend_from_slice(&sig.to_bytes());
        Bytes::from_slice(env, &p)
    }

    fn setup(env: &Env) -> (PriceVerifierClient<'_>, SigningKey) {
        env.mock_all_auths();
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let id = env.register(PriceVerifier, ());
        let c = PriceVerifierClient::new(env, &id);
        c.initialize(&Address::generate(env), &BytesN::from_array(env, &key.verifying_key().to_bytes()));
        (c, key)
    }

    #[test]
    fn decodes_signed_update() {
        let env = Env::default();
        let (c, key) = setup(&env);
        let v = c.verify_update(&update(&env, &key, 7, 38_000_000_000, -8, 1_700_000_000_000_000));
        assert_eq!(v, VerifiedPrice { feed_id: 7, price: 38_000_000_000, exponent: -8, publish_time_us: 1_700_000_000_000_000 });
    }

    #[test]
    #[should_panic]
    fn rejects_other_signer() {
        let env = Env::default();
        let (c, _) = setup(&env);
        let other = SigningKey::from_bytes(&[9u8; 32]);
        c.verify_update(&update(&env, &other, 7, 38_000_000_000, -8, 1));
    }

    #[test]
    #[should_panic]
    fn rejects_tampered_price() {
        let env = Env::default();
        let (c, key) = setup(&env);
        let u = update(&env, &key, 7, 38_000_000_000, -8, 1);
        let mut raw = [0u8; 88];
        u.copy_into_slice(&mut raw);
        raw[11] ^= 1; // cambia el precio sin volver a firmar
        c.verify_update(&Bytes::from_slice(&env, &raw));
    }

    #[test]
    fn initialize_only_once() {
        let env = Env::default();
        let (c, key) = setup(&env);
        let r = c.try_initialize(&Address::generate(&env), &BytesN::from_array(&env, &key.verifying_key().to_bytes()));
        assert_eq!(r, Err(Ok(Error::AlreadyInitialized)));
    }
}
