use super::*;
#[test]
fn catalog_rejects_duplicates_bounds_invalid_selection_and_schema() {
    let cwd = PathBuf::from("/project");
    let id = crate::config::identity().unwrap();
    let base = Catalog {
        version: 1,
        cwd: cwd.clone(),
        selected: id.clone(),
        entries: vec![CatalogEntry {
            id,
            title: "Conversation 1".into(),
            legacy: false,
        }],
    };
    assert!(base.validate(&cwd).is_ok());
    let mut duplicate = base.clone();
    duplicate.entries.push(base.entries[0].clone());
    let mut oversized = base.clone();
    oversized.entries = (0..33)
        .map(|_| CatalogEntry {
            id: crate::config::identity().unwrap(),
            title: "fixture".into(),
            legacy: false,
        })
        .collect();
    oversized.selected = oversized.entries[0].id.clone();
    let mut selection = base.clone();
    selection.selected = crate::config::identity().unwrap();
    let mut identity = base.clone();
    identity.entries[0].id = "../../outside".into();
    let mut title = base.clone();
    title.entries[0].title = "x".repeat(65);
    let mut version = base.clone();
    version.version = 2;
    for invalid in [duplicate, oversized, selection, identity, title, version] {
        assert!(invalid.validate(&cwd).is_err());
    }
    assert!(
        base.validate(std::path::Path::new("/other-project"))
            .is_err()
    );
    assert!(serde_json::from_value::<Catalog>(serde_json::json!({"version":1,"cwd":"/project","selected":base.selected,"entries":base.entries,"unknown":true})).is_err());
}
