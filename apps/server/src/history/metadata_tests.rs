use super::*;
use std::io::{BufReader, Cursor, Read};

#[test]
fn selected_metadata_limits_and_arbitrary_field_order() {
    for field in ["parentId", "type"] {
        let extra = if field == "type" {
            ""
        } else {
            r#", "type":"compaction""#
        };
        let input = format!(r#"{{"{field}":"{}","id":"leaf"{extra}}}"#, "x".repeat(1025));
        let error = read_metadata(input.as_bytes(), "leaf").err().unwrap();
        assert!(error.to_string().contains("exceeds 1024 UTF-8 bytes"));
    }
    let input = format!(
        r#"{{"message":{{"role":"{}"}},"id":"leaf","type":"message"}}"#,
        "x".repeat(1025)
    );
    let error = read_metadata(input.as_bytes(), "leaf").err().unwrap();
    assert!(error.to_string().contains("exceeds 1024 UTF-8 bytes"));
    let input = format!(
        r#"{{"parentId":"{}","id":"leaf","type":"compaction"}}"#,
        "é".repeat(512)
    );
    assert_eq!(
        read_metadata(input.as_bytes(), "leaf")
            .unwrap()
            .unwrap()
            .parent_id
            .unwrap()
            .len(),
        1024
    );
}

/// Generates large tokens without allocating a large fixture in the test process.
fn huge_token<'a>(prefix: &'a str, suffix: &'a str) -> impl BufRead + 'a {
    BufReader::new(
        Cursor::new(prefix.as_bytes())
            .chain(std::io::repeat(b'x').take(32 * 1024 * 1024))
            .chain(Cursor::new(suffix.as_bytes())),
    )
}

#[test]
fn streams_huge_inactive_id_without_retaining_it() {
    for (prefix, suffix) in [
        (
            r#"{"id":""#,
            r#"","type":"message","message":{"role":"user"}}"#,
        ),
        (
            r#"{"type":"message","message":{"role":"user"},"id":""#,
            r#""}"#,
        ),
    ] {
        assert!(
            read_metadata(huge_token(prefix, suffix), "leaf")
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn streams_huge_keys_and_payloads() {
    for (prefix, suffix) in [
        (
            r#"{""#,
            r#"":{"ignored":[true,false,null,1.2e-3]},"id":"leaf","type":"compaction"}"#,
        ),
        (
            r#"{"message":{"content":""#,
            r#"","role":"user"},"id":"leaf","parentId":null,"type":"message"}"#,
        ),
    ] {
        let metadata = read_metadata(huge_token(prefix, suffix), "leaf")
            .unwrap()
            .unwrap();
        assert_eq!(metadata.id.as_deref(), Some("leaf"));
    }
}

#[test]
fn decodes_escapes_unicode_and_one_byte_reads() {
    let input = br#"{"mess\u0061ge":{"content":[{"x":"\uD83D\uDE00"}],"ro\u006ce":"us\u0065r"},"parentId":"p\n\"\\\/\b\f\r\t","\u0069d":"\u0061\uD83D\uDE00","type":"message"}"#;
    let metadata = read_metadata(BufReader::with_capacity(1, Cursor::new(input)), "a😀")
        .unwrap()
        .unwrap();
    assert_eq!(metadata.id.as_deref(), Some("a😀"));
    assert_eq!(metadata.message.unwrap().role, "user");
    assert_eq!(
        metadata.parent_id.as_deref(),
        Some("p\n\"\\/\u{8}\u{c}\r\t")
    );
    let input = r#"{"id":"é😀","type":"compaction","unknown":"é😀"}"#;
    assert!(
        read_metadata(BufReader::with_capacity(1, Cursor::new(input)), "é😀")
            .unwrap()
            .is_some()
    );
}

#[test]
fn limits_are_decoded_bytes_not_escape_spelling() {
    let id = "é".repeat(512);
    let input = format!(
        r#"{{"id":"{}","type":"compaction"}}"#,
        "\\u00e9".repeat(512)
    );
    assert!(read_metadata(input.as_bytes(), &id).unwrap().is_some());
    let input = format!(
        r#"{{"id":"leaf","type":"compaction","parentId":"{}a"}}"#,
        "\\u00e9".repeat(512)
    );
    assert!(read_metadata(input.as_bytes(), "leaf").is_err());
}

#[test]
fn validates_ignored_numbers_without_magnitude_allocation() {
    for number in [
        "0",
        "-0",
        "123",
        "-12.34",
        "0.1e+23",
        "1E-2",
        "1e99999999999999999999999",
    ] {
        let input = format!(r#"{{"id":"leaf","type":"compaction","ignored":{number}}}"#);
        assert!(
            read_metadata(input.as_bytes(), "leaf").unwrap().is_some(),
            "{number}"
        );
    }
    for number in [
        "+1", "01", "-01", "1.", ".1", "1e", "1e+", "--1", "NaN", "Infinity", "1 2",
    ] {
        let input = format!(r#"{{"id":"leaf","type":"compaction","ignored":{number}}}"#);
        assert!(read_metadata(input.as_bytes(), "leaf").is_err(), "{number}");
    }
}

#[test]
fn rejects_duplicate_metadata_including_escaped_names() {
    for duplicate in [
        r#""id":null,"id":"leaf""#,
        r#""id":"leaf","\u0069d":"leaf""#,
        r#""type":"message""#,
        r#""parentId":null,"parentId":null"#,
        r#""display":null,"display":true"#,
        r#""message":null,"message":null"#,
        r#""message":{"role":"user","role":"user"}"#,
    ] {
        let input = format!(r#"{{"type":"compaction",{duplicate}}}"#);
        assert!(read_metadata(input.as_bytes(), "leaf").is_err(), "{input}");
    }
}

#[test]
fn rejects_malformed_and_truncated_json_even_on_inactive_records() {
    for value in [
        r#""\x""#,
        r#""\uD800""#,
        r#""\uDC00""#,
        r#""\uD800\u0041""#,
        r#""\uZZZZ""#,
        "\"line\nbreak\"",
        "[1,]",
        "{\"x\":1,}",
        "tru",
        "nulL",
        "[}",
    ] {
        let input = format!(r#"{{"id":"inactive","type":"compaction","ignored":{value}}}"#);
        assert!(read_metadata(input.as_bytes(), "leaf").is_err(), "{input}");
    }
    for input in [
        "[]",
        "null",
        "{}",
        "{\"type\":null}",
        "{\"type\":\"message\",\"message\":{}}",
        "{\"type\":\"message\",\"id\":42}",
        "{\"type\":\"compaction\"} true",
    ] {
        assert!(read_metadata(input.as_bytes(), "leaf").is_err(), "{input}");
    }
    let complete =
        br#"{"id":"leaf","type":"message","message":{"role":"user","content":[1,true,null,"ok"]}}"#;
    for end in 0..complete.len() {
        assert!(
            read_metadata(&complete[..end], "leaf").is_err(),
            "prefix {end}"
        );
    }
    let invalid_utf8 = b"{\"type\":\"compaction\",\"ignored\":\"\xf0\x80\x80\x80\"}";
    assert!(read_metadata(&invalid_utf8[..], "leaf").is_err());
    let invalid_utf8 = b"{\"type\":\"compaction\",\"ignored\":\"\xed\xa0\x80\"}";
    assert!(read_metadata(&invalid_utf8[..], "leaf").is_err());
}

#[test]
fn enforces_container_depth_boundary() {
    for depth in [63, 64] {
        let input = format!(
            r#"{{"id":"leaf","type":"compaction","ignored":{}0{}}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        );
        assert_eq!(read_metadata(input.as_bytes(), "leaf").is_ok(), depth == 63);
    }
    let input = format!(
        r#"{{"type":"message","message":{{"role":"user","content":{}0{}}}}}"#,
        "[".repeat(63),
        "]".repeat(63)
    );
    assert!(read_metadata(input.as_bytes(), "leaf").is_err());
}

#[test]
fn oversized_discarded_tokens_still_require_valid_endings() {
    let prefix = format!(r#"{{"type":"compaction","id":"{}"#, "x".repeat(2048));
    for suffix in [r#"\uD800"}"#, r#"\x"}"#, "", "\n\"}"] {
        let input = format!("{prefix}{suffix}");
        assert!(read_metadata(input.as_bytes(), "leaf").is_err());
    }
}

#[test]
fn propagates_reader_errors() {
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("test read failure"))
        }
    }
    let reader = Cursor::new(br#"{"type":"compaction","id":""#).chain(Broken);
    let error = read_metadata(BufReader::new(reader), "leaf").err().unwrap();
    assert_eq!(error.to_string(), "test read failure");
}
