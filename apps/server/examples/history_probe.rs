//! Read-only CLI for a stable v3 session and an authoritative leaf ID.

use pi_web::history::{Result, project};

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: history_probe <stable-session.jsonl> <verified-leaf-id>".into());
    }
    let result = project(std::fs::File::open(&args[0])?, &args[1])?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
