# ADR 002: firebase-backed-queue

Status: accepted

Decision: Video Lab uses firebase-backed-queue as a core MVP decision to keep the system Firebase-compatible, OpenAPI-first, auditable, and ready for future integrations without duplicating business logic.

Consequences: implementation remains simple for the showcase while preserving clear service boundaries and production hardening points.
