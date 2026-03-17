# Portfolio-Inspired Roadmap

This document explains how dormant portfolio projects should influence the active `aws-swarm` roadmap.

`aws-swarm` is the product. `firehorse`, `kyro`, and `cosyworld` are input signals. They do not carry independent delivery roadmaps unless explicitly reactivated.

**Last reviewed:** 2026-03-16

> **Issue-indexed execution model.** This document is a roadmap input, not a second backlog. Every executable item still belongs in GitHub Issues with labels, acceptance criteria, and a milestone. If this document and the issue queue conflict, the issue queue wins.

## Purpose

Use this document during roadmap reviews and issue triage to answer one question:

How should insights from the broader avatar portfolio change what `aws-swarm` builds next?

The intended result is a stronger Swarm roadmap, not a portfolio museum.

## Portfolio Roles

| Project | Portfolio role | What it contributes to Swarm | What it should not do |
| --- | --- | --- | --- |
| `aws-swarm` | Active product | Revenue engine, managed platform, shared-room runtime, memory governance, deployment system | Absorb speculative experiments into the core before they are validated |
| `firehorse` | Dormant custom-delivery reference | Sellability signal, white-label deployment patterns, public-channel behavior, noisy-chat memory synthesis | Become a parallel product roadmap |
| `kyro` | Dormant R&D reference | Identity continuity, cross-platform memory, user-controlled memory concepts, trust surfaces | Define the default commercial story for Swarm |
| `cosyworld` | Dormant framework reference | Presence, initiative, affinity, cast behavior, richer avatar sociality | Pull Swarm into unconstrained simulation by default |

## Product Thesis

`aws-swarm` should become the managed operating system for AI avatars:

- deterministic shared-room coordination
- multi-platform runtime and deployment
- persona and capability management
- governed memory with retention, export, and delete controls
- admin, analytics, and operational visibility

Portfolio-derived work should only enter the roadmap when it strengthens one of those product pillars.

## How To Use This Document

During biweekly or monthly roadmap review:

1. Start with the current `ROADMAP.md` and open GitHub milestones.
2. Use this document to identify the next Swarm-native capability worth decomposing.
3. Create one GitHub epic or feature issue per approved capability.
4. Break that issue into smaller execution issues only after scope, packages, and acceptance criteria are clear.
5. Do not open speculative parking-lot issues if the active backlog is already at cap.

This document is intentionally opinionated about sequencing. It assumes the current governance model, WIP caps, and risk-first delivery rules remain in force.

## Strategic Lanes

Swarm should pull from the portfolio through four lanes. These are ordered from most commercially immediate to most speculative.

| Lane | Primary source | Swarm-native outcome | Default milestone bias |
| --- | --- | --- | --- |
| Productization and deployment velocity | `firehorse` | Easier to sell, launch, and repeat across tenants | `Roadmap: Next` |
| Identity and memory continuity | `kyro` | Stronger relational moat and user trust | `Roadmap: Next` or `Roadmap: Later`, depending on hardening load |
| Shared-room presence and cast design | `cosyworld` | More expressive multi-avatar behavior without losing control | `Roadmap: Later` |
| Labs and frontier validation | `kyro` + `cosyworld` | Future differentiation if validated | No milestone until proven |

## Lane 1: Productization And Deployment Velocity

Inspired primarily by `firehorse`.

### Strategic outcome

Make Swarm faster to deploy, easier to template, and easier to sell as repeatable infrastructure rather than one-off craftsmanship.

### Epic candidates

| Epic candidate | Business outcome | Likely packages |
| --- | --- | --- |
| Persona template system | Reduce time-to-launch for new customer avatars | `admin-api`, `admin-ui`, `core` |
| Platform behavior profiles | Let operators choose channel behavior without prompt surgery | `core`, `handlers`, `admin-api` |
| White-label launch packs | Standardize deployment for common customer archetypes | `admin-api`, `admin-ui`, `infra` |
| Noisy-chat memory synthesis | Improve recall quality in high-volume public rooms | `handlers`, `core`, `admin-api` |

### Recommended issue sequence

1. Persona template system
2. Platform behavior profiles
3. White-label launch packs
4. Noisy-chat memory synthesis

### Promotion gate

Promote these items when the active roadmap needs stronger sellability, faster onboarding, or cleaner repeated delivery across customers.

## Lane 2: Identity And Memory Continuity

Inspired primarily by `kyro`.

### Strategic outcome

Give Swarm a stronger relational moat by letting avatars remember the same user across contexts with clearer memory boundaries and trust controls.

### Epic candidates

| Epic candidate | Business outcome | Likely packages |
| --- | --- | --- |
| Cross-platform identity graph | Link one user across Telegram, Discord, web, and wallet surfaces | `admin-api`, `core`, `handlers` |
| Scoped memory model | Separate ephemeral, relational, and canonical memory | `core`, `handlers`, `admin-api` |
| User-visible memory controls | Improve trust with inspectable export/delete surfaces | `admin-api`, `admin-ui` |
| Relationship continuity metrics | Show whether memory actually improves retention and engagement | `admin-api`, `admin-ui`, `handlers` |

### Recommended issue sequence

1. Scoped memory model
2. Cross-platform identity graph
3. User-visible memory controls
4. Relationship continuity metrics

### Promotion gate

Promote these items when Swarm needs clearer long-term differentiation beyond orchestration and ops, or when design partners ask for durable user relationships across platforms.

## Lane 3: Shared-Room Presence And Cast Design

Inspired primarily by `cosyworld`.

### Strategic outcome

Make multi-avatar rooms feel more intentional and socially legible without giving up deterministic control.

### Epic candidates

| Epic candidate | Business outcome | Likely packages |
| --- | --- | --- |
| Presence scoring policy engine | Better responder choice in shared rooms | `core`, `handlers` |
| Sticky affinity and turn-balance rules | Reduce repetitive or awkward room dynamics | `core`, `handlers` |
| Cast-level behavior configuration | Let operators define roles for multi-avatar rooms | `admin-api`, `admin-ui`, `core` |
| Optional narrative state layer | Enable premium social or entertainment experiences | `core`, `handlers`, `admin-api` |

### Recommended issue sequence

1. Presence scoring policy engine
2. Sticky affinity and turn-balance rules
3. Cast-level behavior configuration
4. Optional narrative state layer

### Promotion gate

Promote these items only after shared-room coordination, observability, and operator controls are already stable. Expressiveness should not outrun control.

## Lane 4: Labs And Frontier Validation

Inspired by `kyro` and `cosyworld`.

### Strategic outcome

Maintain a place to test high-upside ideas without contaminating the core product roadmap.

### Candidate experiments

| Experiment | Why it matters | Default status |
| --- | --- | --- |
| Portable memory artifacts | Could become a differentiated export or portability story | Stay out of milestone until a concrete product case exists |
| User-owned identity and memory primitives | Potential long-term moat around continuity and trust | Keep in research unless demanded by a buyer or partner |
| World-state mechanics | Useful for entertainment or premium cast experiences | Validate in a prototype before roadmap promotion |

### Promotion gate

Labs ideas should only enter `Roadmap: Later` after:

- a design partner, internal demo, or experiment proves demand
- the idea can be described as a Swarm-native capability
- scope is small enough to fit the existing issue model

## Sequencing View

This is the recommended portfolio-informed order of investment for `aws-swarm` once current operational hardening work is under control.

1. Productization and deployment velocity
2. Identity and memory continuity
3. Shared-room presence and cast design
4. Labs and frontier validation

That order reflects commercial leverage, not technical novelty.

## Candidate Issue Seeds

These are not backlog commitments. They are issue seeds to use when capacity opens and roadmap review approves promotion.

| Candidate issue title | Lane | Inspired by | Milestone bias | Package focus | Business outcome |
| --- | --- | --- | --- | --- | --- |
| Persona template system for repeatable tenant launches | Productization and deployment velocity | `firehorse` | `Roadmap: Next` | `admin-api`, `admin-ui`, `core` | Reduce setup friction for new customer avatars |
| Channel behavior profiles for platform-specific reply policy | Productization and deployment velocity | `firehorse` | `Roadmap: Next` | `core`, `handlers`, `admin-api` | Make behavior tuning safer than prompt-only edits |
| Memory synthesis pipeline for high-volume public channels | Productization and deployment velocity | `firehorse` | `Roadmap: Next` | `handlers`, `core`, `admin-api` | Improve recall quality without exploding context size |
| Scoped memory tiers with explicit retrieval policy | Identity and memory continuity | `kyro` | `Roadmap: Next` | `core`, `handlers`, `admin-api` | Create a clearer and more governable memory model |
| Cross-platform user identity linking for relational continuity | Identity and memory continuity | `kyro` | `Roadmap: Later` | `admin-api`, `core`, `handlers` | Preserve relationships across surfaces |
| User-facing memory transparency and control surfaces | Identity and memory continuity | `kyro` | `Roadmap: Later` | `admin-api`, `admin-ui` | Increase trust and enterprise readiness |
| Presence scoring policy engine for shared-room responder choice | Shared-room presence and cast design | `cosyworld` | `Roadmap: Later` | `core`, `handlers` | Improve multi-avatar room quality |
| Cast behavior configuration for multi-avatar rooms | Shared-room presence and cast design | `cosyworld` | `Roadmap: Later` | `admin-api`, `admin-ui`, `core` | Make shared-room behavior operator-configurable |

## Issue Creation Rules

When creating a feature issue from this document:

1. State the `lane` explicitly in the issue body.
2. State the `inspired by` source explicitly in the issue body.
3. Convert the portfolio idea into Swarm-native language. The issue should describe a Swarm capability, not "port FireHorse" or "copy CosyWorld."
4. Keep non-goals explicit so speculative spread stays contained.
5. Prefer one epic issue plus a small number of child issues over opening many thin backlog items.

## Good Issue Framing

Good:

- "Add scoped memory tiers with retrieval policy enforcement for shared-room and direct-chat contexts"
- "Introduce persona templates for repeatable tenant onboarding in admin chat flows"
- "Add configurable presence scoring rules to shared-room turn arbitration"

Bad:

- "Port Kyro memory into Swarm"
- "Make Swarm more like CosyWorld"
- "Rebuild FireHorse as a product module"

## Exit Criteria

This document is doing its job if:

- Swarm roadmap reviews use it to justify new issue creation
- new feature issues reference a lane and inspiration source
- dormant projects stop competing with Swarm for roadmap attention
- shipped Swarm features become more sellable, more relational, or more expressive without becoming less governable
