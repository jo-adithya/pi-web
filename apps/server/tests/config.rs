use pi_web::config::{Config, Startup, capability, identity};
fn parse(args: &[&str]) -> std::io::Result<Option<Config>> {
    Config::parse(args.iter().map(|s| (*s).to_owned()))
}
#[test]
fn explicit_modes_and_loopback_port_validation() {
    assert_eq!(parse(&[]).unwrap().unwrap().startup, Startup::Remembered);
    assert_eq!(parse(&["--new"]).unwrap().unwrap().startup, Startup::New);
    assert_eq!(
        parse(&["--session", "fixture.jsonl"])
            .unwrap()
            .unwrap()
            .startup,
        Startup::Session("fixture.jsonl".into())
    );
    let config = parse(&["--port", "0", "--isolated", "--state-dir", "relative-state"])
        .unwrap()
        .unwrap();
    assert_eq!(config.port, 0);
    assert!(config.isolated);
    assert!(config.state_dir.is_absolute());
    assert!(parse(&["--help"]).unwrap().is_none());
}
#[test]
fn rejects_conflicts_unknown_flags_missing_paths_and_invalid_ports() {
    for args in [
        vec!["--new", "--session", "fixture"],
        vec!["--new", "--new"],
        vec!["--port", "65536"],
        vec!["--port", "-1"],
        vec!["--port", "NaN"],
        vec!["--cwd"],
        vec!["--cwd", "--new"],
        vec!["--bind", "0.0.0.0"],
        vec!["--cwd", "/path/that/does/not/exist"],
    ] {
        assert!(parse(&args).is_err(), "{args:?}");
    }
}
#[test]
fn identity_and_capability_have_separate_random_formats() {
    let first = identity().unwrap();
    let second = identity().unwrap();
    assert_ne!(first, second);
    assert_eq!(first.len(), 36);
    assert_eq!(&first[14..15], "4");
    assert!(["8", "9", "a", "b"].contains(&&first[19..20]));
    let token = capability().unwrap();
    assert_eq!(token.len(), 64);
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_ne!(token, capability().unwrap());
}

#[test]
fn registry_location_and_explicit_flags_preserve_legacy_state_defaults() {
    let default = parse(&[]).unwrap().unwrap();
    assert!(!default.explicit_cwd);
    assert!(!default.custom_state);
    assert_eq!(default.registry_dir.file_name().unwrap(), "workspaces");
    assert_eq!(default.registry_dir.parent(), default.state_dir.parent());
    let custom = parse(&["--cwd", ".", "--state-dir", "custom-state"])
        .unwrap()
        .unwrap();
    assert!(custom.explicit_cwd);
    assert!(custom.custom_state);
    assert_eq!(custom.registry_dir, custom.state_dir.join("workspaces"));
}
