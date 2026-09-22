# Versioning

The next JavaScript library and agent release is **2.0.0**. Mandatory agent
authentication and stricter request and persistence handling require an explicit
migration from the 1.x agent contract. See the [changelog](../CHANGELOG.md).

**3.0.0 is reserved for the release that integrates both FCMP++ and Carrot.**
Do not use the 3.x series for the current hardening, documentation or adapter work.
Both integrations must be implemented and validated before that major release.

Each adapter has its own semantic version. A suite release does not require every
repository to share the JavaScript version number. Composer libraries derive their
versions from Git tags; they do not duplicate that version in `composer.json`.

Entries marked `Unreleased` describe local release preparation, not published
packages. Create release tags only after testing and publication approval.
