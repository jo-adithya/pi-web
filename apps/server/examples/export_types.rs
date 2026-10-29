//! Generates the frontend protocol declarations, or checks them without modification.
use std::{error::Error, path::PathBuf};

use pi_web::protocol::typescript_bindings;

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let check = match args.as_slice() {
        [] => false,
        [arg] if arg == "--check" => true,
        _ => return Err("usage: export_types [--check]".into()),
    };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/src/generated/protocol.ts");
    let generated = typescript_bindings();
    if check {
        if std::fs::read_to_string(&path)? != generated {
            return Err("generated protocol types are stale; run bun run types:generate".into());
        }
    } else {
        std::fs::create_dir_all(path.parent().ok_or("missing output directory")?)?;
        std::fs::write(path, generated)?;
    }
    Ok(())
}
