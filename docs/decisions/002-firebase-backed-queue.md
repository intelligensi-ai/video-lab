# ADR 002: firebase-backed-queue

Status: accepted

Decision: Video Lab uses firebase-backed-queue as a core MVP decision to keep the system Firebase-compatible, OpenAPI-first, auditable, and ready for future integrations without duplicating business logic.

Consequences: local development uses an in-memory queue. Production creates the
generation, hashed idempotency record, per-user active lock, queue item and global
capacity update transactionally in Firestore. Workers use reclaimable leases and
server-only authentication. Direct browser access to every queue record is denied.
