//! Session secrets kept in the operating system credential store (Windows Credential Manager).
//! Only a fixed set of names can be read or written from the interface.

const SERVICE: &str = "com.vela.desktop";
const ALLOWED: [&str; 1] = ["stremio-auth-key"];

fn checked(name: &str) -> Result<&str, String> {
    ALLOWED
        .iter()
        .find(|allowed| **allowed == name)
        .copied()
        .ok_or_else(|| "Unknown secret.".to_owned())
}

#[cfg(windows)]
fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, checked(name)?)
        .map_err(|_| "The Windows credential store is unavailable.".to_owned())
}

#[cfg(windows)]
#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("The saved session could not be read.".to_owned()),
    }
}

#[cfg(windows)]
#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 {
        return Err("Invalid secret.".to_owned());
    }
    entry(&name)?
        .set_password(&value)
        .map_err(|_| "The session could not be saved in the Windows credential store.".to_owned())
}

#[cfg(windows)]
#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("The saved session could not be removed.".to_owned()),
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    checked(&name)?;
    Ok(None)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn secret_set(name: String, _value: String) -> Result<(), String> {
    checked(&name)?;
    Err("Secure session storage is available only on Windows.".to_owned())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    checked(&name).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_secret_names_are_accessible() {
        assert!(checked("stremio-auth-key").is_ok());
        assert!(checked("other").is_err());
        assert!(checked("").is_err());
    }
}
