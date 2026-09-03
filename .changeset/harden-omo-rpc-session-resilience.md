---
'kimaki': minor
---

Harden the omo RPC session layer with three resilience behaviors ported from omon-gateway: a whole-turn deadline (`KIMAKI_RPC_TURN_DEADLINE_MS`, default 15m) that aborts and kills a looping turn instead of occupying the Discord thread forever, a one-shot automatic retry when the omo RPC child dies mid-turn (the durable `--session` file preserves the conversation), and a corrupt-session fallback that quarantines an unreadable session file and starts a fresh session instead of wedging the thread.
