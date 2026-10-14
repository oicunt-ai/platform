# OICUNT Company Vision

Direction, not implementation. Anything here marked OPEN has no approved
decision — do not present it as decided, and do not invent business-model,
customer-segment, roadmap or UI specifics beyond this file.

## Established direction

- **OICUNT AI** powers multiple AI products through reusable shared
  infrastructure (the Platform + AI Platform repositories).
- **BILLY** is the first standalone AI chatbot product built on that
  infrastructure.
- Repositories stay independent: company platform, AI platform and product
  evolve separately and integrate only over stable public HTTP contracts.
- Verified milestone (historical finding, reverify live state when needed):
  authenticated public completion → admission → Memory hydration → Groq
  inference → durable metering → RabbitMQ settlement → Memory checkpoint.

## Product principles (proposed)

- Bot replies stay grounded in provided context; reasoning internals are
  privacy-gated (`exposeReasoning` opt-in).
- Usage is measured authoritatively per tenant/user; corrections are
  append-only reversals, never silent edits.
- Development identity is strictly local (ephemeral dev issuer); production
  uses a real identity provider (undecided which).

## OPEN DECISIONS (unapproved — do not assume)

1. Target audience and customer segments.
2. Public launch strategy and timelines.
3. Pricing and packaging (including how metered usage maps to bills).
4. Production authentication provider and session design.
5. Long-term feature roadmap (agents, tools, multimodal, voice).
6. Design language and UX specification for BILLY and future products.
7. Which future products follow BILLY, and in what order.
