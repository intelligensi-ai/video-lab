# Runtime adapter
`VideoRuntimeAdapter` defines health, submit, status, cancel, and output fetch operations. `MockVideoRuntimeAdapter` supports local deterministic completion and failure markers. `SulphurLtxRuntimeAdapter` reads endpoint and token from environment and maps public settings into provider payloads without leaking provider fields into OpenAPI.
