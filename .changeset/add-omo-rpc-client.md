---
'kimaki': minor
---

Add an in-repo omo RPC client that talks classic `omo --mode rpc --session` over process stdio (LF JSONL, no readline) and injects the packaged `omomaki-approve` extension with `--extension` instead of writing into the user agent directory.
