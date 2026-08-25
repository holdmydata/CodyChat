//! Entra ID (Azure AD) device-code auth for the Azure AI Foundry chat
//! backend. Lives in Rust rather than the frontend specifically to avoid
//! the Microsoft identity platform's /devicecode and /token endpoints,
//! which are built for native/CLI clients and don't reliably support CORS
//! the way the SPA-registered authorization-code flow does — a plain
//! `fetch` from the webview risks a silent CORS failure. reqwest (already
//! a dependency, already used the same way in skills.rs::web_fetch) has no
//! such restriction.
//!
//! The refresh token is the one genuinely sensitive, long-lived secret this
//! app handles — stored via the `keyring` crate (OS credential store),
//! unlike every other app-level setting, which lives in the frontend's
//! plaintext localStorage (see the comment on memory::MemoryState in
//! lib.rs). Short-lived access tokens stay in-memory-only Rust state and
//! are never sent to the frontend except as the direct return value of
//! azure_get_access_token, used immediately as a bearer header.
//!
//! Deliberately stateless across process restarts on the Rust side beyond
//! the keyring entry: tenant_id/client_id are supplied by the frontend on
//! every call (it already persists them in Settings) rather than cached
//! here, so there's nothing to reconcile if the user edits those fields.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const KEYRING_SERVICE: &str = "codychat-azure";

struct PendingDeviceCode {
    device_code: String,
    tenant_id: String,
    client_id: String,
}

struct AccountState {
    tenant_id: String,
    client_id: String,
    upn: Option<String>,
    access_token: String,
    // Backed off 60s from the real expiry so a token that's technically
    // still valid but about to lapse mid-request gets refreshed proactively
    // instead of failing the in-flight chat call.
    expires_at: Instant,
}

#[derive(Default)]
pub struct AzureAuthInner {
    pending: Option<PendingDeviceCode>,
    account: Option<AccountState>,
}

pub struct AzureAuthState(pub Mutex<AzureAuthInner>);

impl AzureAuthState {
    pub fn new() -> Self {
        AzureAuthState(Mutex::new(AzureAuthInner::default()))
    }
}

#[derive(Serialize)]
pub struct DeviceCodeInfo {
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AuthPollResult {
    Pending,
    SignedIn { upn: Option<String> },
    Error { message: String },
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

fn poison_err<T>(_: T) -> String {
    "azure auth state lock poisoned".to_string()
}

// The JWT's middle segment (payload) — decoded, never signature-verified,
// since it's only used to show the signed-in account name in Settings, not
// as an authorization decision. The access token (which *is* verified, by
// Azure, on every API call it's sent with) is the only thing that actually
// gates access.
fn decode_upn_from_id_token(id_token: &str) -> Option<String> {
    let payload_b64 = id_token.split('.').nth(1)?;
    let payload_bytes = URL_SAFE_NO_PAD.decode(payload_b64).ok()?;
    let payload: Value = serde_json::from_slice(&payload_bytes).ok()?;
    payload
        .get("preferred_username")
        .or_else(|| payload.get("upn"))
        .or_else(|| payload.get("unique_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn keyring_entry(tenant_id: &str, client_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("{tenant_id}:{client_id}")).map_err(|e| e.to_string())
}

fn store_refresh_token(tenant_id: &str, client_id: &str, refresh_token: &str) -> Result<(), String> {
    keyring_entry(tenant_id, client_id)?
        .set_password(refresh_token)
        .map_err(|e| e.to_string())
}

fn load_refresh_token(tenant_id: &str, client_id: &str) -> Option<String> {
    keyring_entry(tenant_id, client_id).ok()?.get_password().ok()
}

fn clear_refresh_token(tenant_id: &str, client_id: &str) -> Result<(), String> {
    let entry = keyring_entry(tenant_id, client_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn call_token_endpoint(tenant_id: &str, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let url = format!("https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token");
    let client = reqwest::blocking::Client::builder()
        .timeout(AUTH_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    client
        .post(&url)
        .form(form)
        .send()
        .map_err(|e| e.to_string())?
        .json::<TokenResponse>()
        .map_err(|e| e.to_string())
}

// Kicks off the device-code flow: registers the pending request with
// Microsoft and stashes the device_code server-side (never sent to the
// frontend — only the human-facing user_code/verification_uri are).
// `scope` is the caller-supplied resource scope (e.g.
// "https://cognitiveservices.azure.com/.default"); openid/profile/
// offline_access are appended here rather than left to the caller, since
// they're required for every sign-in to get back an id_token (for the
// display name) and a refresh_token (for silent renewal) regardless of
// which resource scope is being requested.
#[tauri::command(rename_all = "snake_case")]
pub fn azure_start_device_code(
    state: State<AzureAuthState>,
    tenant_id: String,
    client_id: String,
    scope: String,
) -> Result<DeviceCodeInfo, String> {
    let full_scope = format!("{scope} openid profile offline_access");
    let url = format!("https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/devicecode");
    let client = reqwest::blocking::Client::builder()
        .timeout(AUTH_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp: DeviceCodeResponse = client
        .post(&url)
        .form(&[("client_id", client_id.as_str()), ("scope", full_scope.as_str())])
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;

    if let Some(err) = resp.error {
        return Err(resp.error_description.unwrap_or(err));
    }
    let device_code = resp.device_code.ok_or("devicecode response missing device_code")?;

    let mut inner = state.0.lock().map_err(poison_err)?;
    inner.pending = Some(PendingDeviceCode { device_code, tenant_id, client_id });

    Ok(DeviceCodeInfo {
        user_code: resp.user_code.ok_or("devicecode response missing user_code")?,
        verification_uri: resp.verification_uri.ok_or("devicecode response missing verification_uri")?,
        expires_in: resp.expires_in.unwrap_or(900),
        interval: resp.interval.unwrap_or(5),
    })
}

// One-shot check with Microsoft: has the user finished signing in yet? The
// frontend calls this on its own interval (per DeviceCodeInfo.interval)
// rather than this command blocking/sleeping itself, so a single poll
// attempt is cheap and the frontend stays in control of the retry timing.
#[tauri::command]
pub fn azure_poll_device_code(state: State<AzureAuthState>) -> Result<AuthPollResult, String> {
    let (device_code, tenant_id, client_id) = {
        let inner = state.0.lock().map_err(poison_err)?;
        match &inner.pending {
            Some(p) => (p.device_code.clone(), p.tenant_id.clone(), p.client_id.clone()),
            None => return Err("no sign-in in progress".to_string()),
        }
    };

    let resp = call_token_endpoint(
        &tenant_id,
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
        ],
    )?;

    if let Some(err) = &resp.error {
        return Ok(match err.as_str() {
            "authorization_pending" | "slow_down" => AuthPollResult::Pending,
            _ => {
                let mut inner = state.0.lock().map_err(poison_err)?;
                inner.pending = None;
                AuthPollResult::Error {
                    message: resp.error_description.clone().unwrap_or_else(|| err.clone()),
                }
            }
        });
    }

    let access_token = resp.access_token.ok_or("token response missing access_token")?;
    let expires_in = resp.expires_in.unwrap_or(3600);
    let upn = resp.id_token.as_deref().and_then(decode_upn_from_id_token);
    if let Some(refresh_token) = &resp.refresh_token {
        store_refresh_token(&tenant_id, &client_id, refresh_token)?;
    }

    let mut inner = state.0.lock().map_err(poison_err)?;
    inner.pending = None;
    inner.account = Some(AccountState {
        tenant_id,
        client_id,
        upn: upn.clone(),
        access_token,
        expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)),
    });

    Ok(AuthPollResult::SignedIn { upn })
}

// The call every Azure chat request makes right before streaming: returns
// the cached access token if it's still fresh, otherwise silently renews it
// from the keyring-stored refresh token. Fails with a plain error (no
// device-code flow triggered automatically) if there's no session at all —
// the frontend surfaces that as "sign in again" rather than this command
// trying to drive UI on its own.
#[tauri::command(rename_all = "snake_case")]
pub fn azure_get_access_token(
    state: State<AzureAuthState>,
    tenant_id: String,
    client_id: String,
) -> Result<String, String> {
    {
        let inner = state.0.lock().map_err(poison_err)?;
        if let Some(account) = &inner.account {
            if account.tenant_id == tenant_id && account.client_id == client_id && account.expires_at > Instant::now() {
                return Ok(account.access_token.clone());
            }
        }
    }

    let refresh_token =
        load_refresh_token(&tenant_id, &client_id).ok_or_else(|| "not signed in to Azure".to_string())?;

    let resp = call_token_endpoint(
        &tenant_id,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh_token.as_str()),
        ],
    )?;

    if let Some(err) = &resp.error {
        // A refresh failure (revoked/expired refresh token) means the
        // stored credential is dead — clear it so the next attempt goes
        // straight to a fresh device-code sign-in instead of retrying a
        // refresh that will just fail the same way again.
        let _ = clear_refresh_token(&tenant_id, &client_id);
        return Err(resp.error_description.clone().unwrap_or_else(|| err.clone()));
    }

    let access_token = resp.access_token.ok_or("token refresh response missing access_token")?;
    let expires_in = resp.expires_in.unwrap_or(3600);
    // Microsoft identity platform rotates refresh tokens on every refresh —
    // the old one becomes invalid, so the new one must overwrite it or the
    // *next* refresh silently starts failing.
    if let Some(new_refresh) = &resp.refresh_token {
        store_refresh_token(&tenant_id, &client_id, new_refresh)?;
    }
    let upn = resp.id_token.as_deref().and_then(decode_upn_from_id_token);

    let mut inner = state.0.lock().map_err(poison_err)?;
    let resolved_upn = upn.or_else(|| inner.account.as_ref().and_then(|a| a.upn.clone()));
    inner.account = Some(AccountState {
        tenant_id,
        client_id,
        upn: resolved_upn,
        access_token: access_token.clone(),
        expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)),
    });

    Ok(access_token)
}

// Called once on app launch (if Settings already has Azure config saved) to
// silently resume a session from the keyring-stored refresh token, without
// forcing the user through the device-code prompt again every relaunch.
// Best-effort: any failure (no stored credential, revoked token, network
// error) just means "not signed in" rather than surfacing as a hard error —
// same posture as useChat.ts's other best-effort startup fetches.
#[tauri::command(rename_all = "snake_case")]
pub fn azure_restore_session(state: State<AzureAuthState>, tenant_id: String, client_id: String) -> Option<String> {
    azure_get_access_token(state.clone(), tenant_id, client_id).ok()?;
    let inner = state.0.lock().ok()?;
    inner.account.as_ref().and_then(|a| a.upn.clone())
}

#[tauri::command(rename_all = "snake_case")]
pub fn azure_sign_out(state: State<AzureAuthState>, tenant_id: String, client_id: String) -> Result<(), String> {
    {
        let mut inner = state.0.lock().map_err(poison_err)?;
        let matches_current = inner
            .account
            .as_ref()
            .map(|a| a.tenant_id == tenant_id && a.client_id == client_id)
            .unwrap_or(false);
        if matches_current {
            inner.account = None;
        }
    }
    clear_refresh_token(&tenant_id, &client_id)
}
