"""Fake redactor to verify that the subprocess calls Hermes' redaction seam."""

def redact_sensitive_text(text: str, *, force: bool = False) -> str:
    assert force is True
    return text.replace("secret", "[redacted]")
